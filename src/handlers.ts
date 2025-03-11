//
//  handlers.ts
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2023-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

import AWS from 'aws-sdk';
import https from 'https';
import {
    APIGatewayAuthorizerResult,
    APIGatewayTokenAuthorizerEvent,
    AuthResponse,
    Handler,
    StatementEffect
} from 'aws-lambda';
import { AzureKeyCredential } from '@azure/core-auth';
import { CommunicationUserIdentifier } from '@azure/communication-common';
import {
    CommunicationIdentityClient,
    GetTokenOptions,
    TokenScope
} from '@azure/communication-identity';
import { AssistanceRequest, User, UserToken } from './types';
import { AttributeMap, QueryInput } from 'aws-sdk/clients/dynamodb';
import * as fs from 'node:fs';
import { UUID, randomUUID } from 'node:crypto';

// Meetings with users waiting for an assistant to join.
const ddb = new AWS.DynamoDB();

// Read environment.
const assistanceRequestsTableName = process.env.ASSISTANCE_REQUESTS_TABLE_NAME!;
const callRecordsTableName = process.env.CALL_RECORDS_TABLE_NAME!;
const communicationUserIdsTableName = process.env.COMMUNICATION_USER_IDS_TABLE_NAME!;
const authUrl = process.env.AUTH_URL!;
const communicationServicesEndpoint = process.env.COMMUNICATION_SERVICES_ENDPOINT!;
const communicationServicesAccesskey = process.env.COMMUNICATION_SERVICES_ACCESSKEY!;
const hours = process.env.HOURS!.split(":").map(intervals => intervals
    .split(",")
    .filter(Boolean)
    .map(interval => interval.split("/").map(time => time.slice(0, 2) + ":" + time.slice(-2)))
);
const extraHours = process.env.EXTRA_HOURS!.split(",").map(interval => {
    const [date, startTime, endTime] = interval.split(/[\/T]/);
    return [date + "T" + startTime, date + "T" + endTime];
});
const holidays = process.env.HOLIDAYS!.split(",");

const communicationIdentityClient = new CommunicationIdentityClient(
    communicationServicesEndpoint,
    new AzureKeyCredential(communicationServicesAccesskey)
);

const ASSISTANCE_REQUESTS_BY_AGE_QUERY: QueryInput = {
    TableName: assistanceRequestsTableName,
    IndexName: 'DateTime',
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: {
        '#pk': 'PartitionKey'
    },
    ExpressionAttributeValues: {
        ':pk': {S: '1'}
    }
};

const ASSISTANCE_REQUEST_KEEPALIVE_INTERVAL_SECONDS: number = 10;

const ASSISTANCE_REQUEST_KEEPALIVE_TIMEOUT_SECONDS: number = 30;

const ASSISTANCE_SESSION_MAXIMUM_DURATION_MINUTES: number = 120;

const NUMBER_OF_DAYS_OF_OPENING_HOURS_RETURNED_BY_INDEX_ENDPOINT: number = 8;

const BACKEND_VERSION: string = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;

const API_VERSION: string = BACKEND_VERSION.match(/\d+\.\d+/)![0];

/*
 * Handlers
 */

// noinspection JSUnusedGlobalSymbols
/**
 * Return a success response.
 */
export const index: Handler = async (_) => {
    const now = new Date();
    const dates = Array(NUMBER_OF_DAYS_OF_OPENING_HOURS_RETURNED_BY_INDEX_ENDPOINT)
        .fill(now)
        .map((v, i) => {
            const date = new Date((new Date(v)).setDate(v.getDate() + i));
            const y = date.getFullYear();
            const m = date.getMonth() + 1;
            const d = date.getDate();
            return `${y}-${('' + m).padStart(2, '0')}-${('' + d).padStart(2, '0')}`;
        });
    const openingHours = dates.map(calculateOpeningHours);

    return response(
        200,
        'application/json',
        JSON.stringify({
            message: 'Success',
            apiVersion: API_VERSION,
            openingHours: {
                time: ('' + now.getHours()).padStart(2, '0') + ':' + ('' + now.getMinutes()).padStart(2, '0'),
                status: openingHours[0].some(([start, end]) => start < now && now < end) ? 'open' : 'closed',
                schedule: openingHours
                    .map(intervals => intervals
                        .map(interval => interval
                            .map(date =>
                                ('' + date.getHours()).padStart(2, '0') + ':' + ('' + date.getMinutes()).padStart(2, '0')
                            )
                            .join('-')
                        )
                        .join(', ')
                    )
                    .reduce((acc, x, i) => ({...acc, [dates[i]]: x}), {})
            }
        })
    );
};

// noinspection JSUnusedGlobalSymbols
/**
 * Request a new assistance session.
 *
 * This will issue an access token for Azure Communication Services to the user that made the request (creating an
 * identity for the user if none exists yet). It will then add the user's identity to the queue to be picked up by an
 * assistant.
 *
 * @param event The event object containing the requestContext, used to associate the request with an identity.
 *
 * @return A 200-response with the ACS user id, access token and expiry time for the user requesting assistance.
 */
export const requestAssistance: Handler = async (event) => {
    const username = event.requestContext.authorizer.principalId;
    console.info(`User ${username} is requesting assistance`);

    const userToken = await getUserToken(
        username,
        ['voip.join'],
        {tokenExpiresInMinutes: ASSISTANCE_SESSION_MAXIMUM_DURATION_MINUTES}
    );
    await createAssistanceRequest(userToken.user);
    return response(
        200,
        'application/json',
        JSON.stringify({userToken, keepaliveInterval: ASSISTANCE_REQUEST_KEEPALIVE_INTERVAL_SECONDS}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Keep assistance request active.
 *
 * This will update the time-to-live on the assistance request of the user. Any assistance requests that are not
 * kept active through this endpoint will be cleaned up, to reduce the number of times assistants will answer a
 * request just to find the user has lost the connection while waiting.
 *
 * @param event The event object containing the requestContext, used to associate the request with an identity.
 *
 * @return 200 if the assistance request was successfully updated, 404 if the assistance request was not found.
 */
export const awaitAssistance: Handler = async (event) => {
    const username = event.requestContext.authorizer.principalId;
    console.info(`User ${username} is waiting for assistance`);
    const user = {username, ...(await getOrCreateCommunicationUserIdentifier(username))};
    return await updateAssistanceRequest(user)
        ? response(200, 'application/json', '{}')
        : response(404, 'application/json', JSON.stringify({message: 'Assistance request not found'}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Remove assistance request.
 *
 * This will delete the assistance request of the user. It is used by the client to clean up the assistance request
 * when the user hangs up while waiting.
 *
 * @param event The event object containing the requestContext, used to associate the request with an identity.
 *
 * @return 200 if the assistance request was successfully deleted, 404 if the assistance request was not found.
 */
export const cancelAssistance: Handler = async (event) => {
    const username = event.requestContext.authorizer.principalId;
    console.info(`User ${username} is giving up on getting assistance`);
    const assistanceRequest = await deleteAssistanceRequest(username);
    if (assistanceRequest) {await logAbandonment(username, assistanceRequest.startDateTime, new Date());}
    return assistanceRequest
        ? response(200, 'application/json', '{}')
        : response(404, 'application/json', JSON.stringify({message: 'Assistance request not found'}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Request an access token for providing assistance.
 *
 * This will issue an access token for azure communication services for the user that made the request (creating an
 * identity for the user, if none exists yet). Unlike the tokens issued to end users, this token will have the
 * necessary scope to make calls (since technically the calls are initiated by the assistant when accepting the
 * request). The token will also have a much longer life-time of 24 hours, since the assistants will typically be
 * online for long stretches of time, unlike the users, which only make one call at a time.
 *
 * @param event The event object containing the requestContext, used to associate the request with an identity.
 *
 * @return A 200-response with the ACS user id, access token and expiry time.
 */
export const assistanceToken: Handler = async (event) => {
    const username = event.requestContext.authorizer.principalId;
    const userToken = await getUserToken(username, ['voip']);
    return response(200, 'application/json', JSON.stringify({userToken}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Get the oldest unanswered assistance request, if any.
 *
 * This allows for checking if there is an assistance request to be answered, so the incoming request can be shown
 * to the assistants.
 *
 * @param _
 *
 * @return A 200-response with the assistance request, if any, a 200-response with an empty object otherwise.
 */
export const offerAssistance: Handler = async (_) => {
    const assistanceRequest = (await getAssistanceRequest());
    return response(200, 'application/json', JSON.stringify({assistanceRequest}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Answer an assistance request.
 *
 * This will retrieve the details for the oldest open assistance request and remove it from the queue.
 *
 * @param event The event object containing the requestContext, used to log which assistant answered the request.
 *
 * @return A 200-response with the assistance request, or 404 if no assistance request is available anymore.
 */
export const beginAssistance: Handler = async (event) => {
    const username = event.requestContext.authorizer.principalId;

    const assistanceRequest = await popAssistanceRequest();
    if (!assistanceRequest) {
        console.info(`There is no meeting in the queue (presumably another assistant was faster to pick up).`);
        return response(404, 'application/json', JSON.stringify({message: 'No meeting found'}));
    }

    console.info(`Assistant ${username} will assist ${assistanceRequest.user.username}`);
    await logAssistance(assistanceRequest.user.username, username, assistanceRequest.startDateTime, new Date());
    return response(200, 'application/json', JSON.stringify({assistanceRequest}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Authorize the request based on basic authentication.
 *
 * This will throw a request's authorization token against the auth url, authorizing the request, if the response has a
 * HTTP status code of 200.
 *
 * @param event     The event object containing the authorization token from the request.
 */
export const auth: Handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
    const token = event.authorizationToken;
    const principalId = Buffer.from(token.split(' ')[1], 'base64').toString('utf-8').split(':')[0];

    return new Promise((resolve, reject) =>
        https
            .request(
                authUrl,
                {
                    method: 'HEAD',
                    headers: { authorization: token }
                },
                (res) => {
                    if (res.statusCode === 200) {
                        resolve(generatePolicy(principalId, 'Allow'));
                    } else {
                        reject("Unauthorized");
                    }
                }
            )
            .on('error', (_) => {
                console.error('Failed to reach authentication server!');
                reject("Unauthorized");
            })
            .end()
    );
};

/*
 * Helpers
 */

const AssistanceRequest = (
    {
        Username,
        CommunicationUserId,
        DateTime,
        TTL
    }: AttributeMap
): AssistanceRequest|undefined => {
    if (!Username?.S
        || !CommunicationUserId?.S
        || !DateTime?.S
        || !TTL?.N
        || +TTL.N < Math.floor(Date.now() / 1000)
    ) {return;}
    return {
        user: {
            username: Username.S,
            communicationUserId: CommunicationUserId.S
        },
        startDateTime: new Date(DateTime.S)
    };
};

const getAssistanceRequestTtl = () => {
    // Set time-to-live to two minutes, causing stale requests to be automatically removed.
    return { N: `${Math.floor(Date.now() / 1000) + ASSISTANCE_REQUEST_KEEPALIVE_TIMEOUT_SECONDS }`};
};

// noinspection JSUnusedLocalSymbols
const listAssistanceRequests = async (): Promise<AssistanceRequest[]> => {
    const queryOutput = await ddb.query(ASSISTANCE_REQUESTS_BY_AGE_QUERY).promise();
    return (queryOutput.Items || []).map(AssistanceRequest).filter((x): x is AssistanceRequest => !!x);
};

const getAssistanceRequest = async (user : User|undefined = undefined): Promise<AssistanceRequest|undefined> => {
    const item = user
        ? (
            await ddb.getItem({
                TableName: assistanceRequestsTableName,
                Key: {
                    Username: {S: user.username}
                }
            }).promise()
        ).Item
        : (await ddb.query({...ASSISTANCE_REQUESTS_BY_AGE_QUERY, Limit: 1}).promise()).Items?.at(0);
    if (!item) {return;}
    const assistanceRequest = AssistanceRequest(item);
    if (!assistanceRequest) {await deleteAssistanceRequest(item.Username.S!)}
    return AssistanceRequest(item) || getAssistanceRequest(user);
};

const createAssistanceRequest = async (user: User, startDateTime: Date = new Date()): Promise<AssistanceRequest> => {
    await ddb.putItem({
        TableName: assistanceRequestsTableName,
        Item: {
            Username: {S: user.username},
            PartitionKey: {S: "1"},
            DateTime: {S: startDateTime.toISOString()},
            CommunicationUserId: {S: user.communicationUserId},

            TTL: getAssistanceRequestTtl()
        }
    }).promise();
    return {user, startDateTime}
};

const updateAssistanceRequest = async (user: User): Promise<AssistanceRequest|undefined> => {
    const assistanceRequest = await getAssistanceRequest(user);
    if (!assistanceRequest) {return;}
    return createAssistanceRequest(user, assistanceRequest.startDateTime);
};

const deleteAssistanceRequest = async (username: string): Promise<AssistanceRequest|undefined> => {
    const result = await ddb.deleteItem({
        TableName: assistanceRequestsTableName,
        ReturnValues: "ALL_OLD",
        Key: {
            Username: {S: username}
        }
    }).promise();
    if (!result.Attributes) {return;}
    return AssistanceRequest(result.Attributes);
};

const popAssistanceRequest = async (): Promise<AssistanceRequest|undefined> => {
    const assistanceRequest = await getAssistanceRequest();
    if (!assistanceRequest) {return;}
    return (await deleteAssistanceRequest(assistanceRequest.user.username))
        ? assistanceRequest
        : popAssistanceRequest();
};

const logAssistance = async (caller: string, assistant: string, startDateTime: Date, acceptDateTime: Date) => {
    await ddb.putItem({
        TableName: callRecordsTableName,
        Item: {
            Caller: {S: caller},
            Assistant: {S: assistant},
            StartDateTime: {S: startDateTime.toISOString()},
            AcceptDateTime: {S: acceptDateTime.toISOString()},
            Meeting: {S: randomUUID()}
        }
    }).promise();
};

const logAbandonment = async (caller: string, startDateTime: Date, endDateTime: Date) => {
    await ddb.putItem({
        TableName: callRecordsTableName,
        Item: {
            Caller: {S: caller},
            StartDateTime: {S: startDateTime.toISOString()},
            EndDateTime: {S: endDateTime.toISOString()},
            Meeting: {S: randomUUID()}
        }
    }).promise();
};

/**
 * Get an existing communication user id from the database for a given user.
 *
 * @param username  The user to look up the communication user id for.
 *
 * @return The CommunicationUserIdentifier for the user, if any.
 */
const getCommunicationUserIdentifier = async (username: string): Promise<CommunicationUserIdentifier|undefined> => {
    const communicationUserId = (
        await ddb
            .getItem({
                TableName: communicationUserIdsTableName,
                Key: {
                    Username: { S: username }
                }
            })
            .promise()
    ).Item?.CommunicationUserId.S;
    return communicationUserId && { communicationUserId } || undefined;
};

/**
 * Create a new communication user for a given user and add it to the database.
 *
 * @param username  The user to create a communication user identity for.
 *
 * @return The CommunicationUserIdentifier for the user.
 */
const createCommunicationUserIdentifier = async (username: string): Promise<CommunicationUserIdentifier> => {
    const communicationUserIdentifier = await communicationIdentityClient.createUser();
    await ddb.putItem({
        TableName: communicationUserIdsTableName,
        Item: {
            Username: { S: username },
            CommunicationUserId: { S: communicationUserIdentifier.communicationUserId }
        }
    }).promise();
    return communicationUserIdentifier;
};

/**
 * Get the communication user id for a given user, creating it, if it does not exist yet.
 *
 * @param username  The user to get or create the communication user identity for.
 *
 * @return The CommunicationUserIdentifier for the user.
 */
const getOrCreateCommunicationUserIdentifier = async (username: string) => {
    const existingId = await getCommunicationUserIdentifier(username);
    const result = existingId || await createCommunicationUserIdentifier(username);
    console.debug(
        `${existingId ? 'Got' : 'Created'} communication user ID '${result.communicationUserId} for user ${username}'`
    );
    return result;
};

/**
 * Get an access token for a customer.
 *
 * @param username  The name of the user to get an access token for.
 * @param scopes    Scopes to include in the token.
 * @param options   Additional options for the token (used for setting expiry time).
 *
 * @return The access token for the customer.
 */
const getUserToken = async (username: string, scopes: TokenScope[], options?: GetTokenOptions): Promise<UserToken> => {
    const user = {username, ...(await getOrCreateCommunicationUserIdentifier(username))};
    const token = await communicationIdentityClient.getToken(user, scopes, options);
    console.debug(`Issued an access token with scope ${scopes} that expires at ${token.expiresOn}`);
    return {...token, user: user};
};

/**
 * Helper function to generate an IAM policy.
 *
 * This is used by the lambda token authorizer to authorize the user.
 *
 * @param principalId   The string used in the principalId field of the AuthResponse.
 * @param effect        The StatementEffect to me effected by the new PolicyDocument.
 *
 * @returns An AuthResponse with a single statement that applies the desired effect to any execute-api:Invoke-Action.
 */
const generatePolicy = (principalId: string, effect: StatementEffect): AuthResponse => ({
    principalId,
    policyDocument: {
        Version: '2012-10-17',
        Statement: [
            {
                Action: 'execute-api:Invoke',
                Effect: effect,
                Resource: '*'
            }
        ]
    }
});

const request = ({body}: {body: string}): {[key: string]: any}|undefined => {
    try {
        const result = JSON.parse(body);
        return typeof result == 'object' ? result : undefined;
    } catch {}
};

const response = (statusCode: number, contentType: string, body: any, isBase64Encoded = false) => ({
    statusCode: statusCode,
    headers: {'Content-Type': contentType,},
    body: body,
    isBase64Encoded
});

/**
 * Calculate opening hours for a given date.
 *
 * @param date  The date to calculate the opening hours for, formatted as YYYY-MM-DD.
 *
 * @returns A list of time intervals, each specified by a tuple of a start and end Date.
 */
const calculateOpeningHours = (date: string): Date[][] => [
    !holidays.includes(date) && hours[(new Date(date)).getUTCDay()].map(x => x.map(y => date + "T" + y)),
    extraHours.filter(([x]) => x.startsWith(date))
]
    .flat()
    .filter((x): x is string[] => !!x)
    .map(interval => interval.map(date => {
        const components = date.split(/[-T:]/);
        return new Date(+components[0], +components[1] - 1, +components[2], +components[3], +components[4])
    }));

const isUUID = (uuid: any): uuid is UUID =>
    typeof uuid == 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){4}[0-9a-f]{8}$/i.test(uuid);
