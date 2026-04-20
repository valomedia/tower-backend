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

AWS.config.update({ region: process.env.AWS_REGION! });

const ddb = new AWS.DynamoDB();
const s3 = new AWS.S3();

// Read environment.
const assistanceRequestsTableName = process.env.ASSISTANCE_REQUESTS_TABLE_NAME!;
const callRecordsTableName = process.env.CALL_RECORDS_TABLE_NAME!;
// 2026-04-14 - DH - renamed from communicationUserIdsTableName to reflect extension
const UsersTableName = process.env.USERS_TABLE_NAME!;
const authUrl = process.env.AUTH_URL!;
const communicationServicesEndpoint = process.env.COMMUNICATION_SERVICES_ENDPOINT!;
const communicationServicesAccesskey = process.env.COMMUNICATION_SERVICES_ACCESSKEY!;
const hours = process.env.HOURS
    ? process.env.HOURS.split(":").map(intervals => intervals
        .split(",")
        .filter(Boolean)
        .map(interval => interval.split("/").map(time => time.slice(0, 2) + ":" + time.slice(-2)))
    )
    : undefined;
const extraHours = process.env.EXTRA_HOURS!.split(",").filter(Boolean).map(interval => {
    const [date, startTime, endTime] = interval.split(/[\/T]/);
    return [date + "T" + startTime, date + "T" + endTime];
});
const holidays = process.env.HOLIDAYS!.split(",").filter(Boolean);
const hoursDescription = process.env.HOURS_DESCRIPTION!;
const uploadBucket = process.env.UPLOAD_BUCKET!;

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

const ASSISTANCE_TOKEN_LIFETIME_MINUTES: number = 720;

const NUMBER_OF_DAYS_OF_OPENING_HOURS_RETURNED_BY_INDEX_ENDPOINT: number = 8;

const BACKEND_VERSION: string = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;

const API_VERSION: string = BACKEND_VERSION.match(/\d+\.\d+/)![0];

const UPLOAD_KEY_ID_LENGTH = 8;

const SIGNED_UPLOAD_URL_EXPIRATION_SECONDS = 300;

const SIGNED_DOWNLOAD_URL_EXPIRATION_SECONDS = ASSISTANCE_SESSION_MAXIMUM_DURATION_MINUTES * 60;

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
                status: (!hours || openingHours[0].some(([start, end]) => start < now && now < end))
                    ? 'open' : 'closed',
                schedule: hours
                    ? openingHours
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
                    : {},
                description: hours ? hoursDescription : ""
            }
        })
    );
};

// noinspection JSUnusedGlobalSymbols
/**
 * Register for an identity.
 *
 * This will create a new identity in Azure Communication Services and file it under a username derived from a randomly
 * generated UUID. This UUID is then returned to the client. It isn't technically necessary for the client to ever
 * hit this endpoint, since the other endpoints will create the necessary user identifiers on the fly, if they don't
 * exist yet. The client can just generate its own random UUID and make its requests with that, and as long as the
 * supplied UUID is the same in every request, everything will still work. The advantage of calling this endpoint is
 * that the ACS user is created ahead of time, giving the identity time to propagate within ACS. This may or may not
 * make the first call slightly more reliable and help to reduce 500-errors from within ACS encountered while
 * establishing the call.
 *
 * @param event The event containing the optional request body with profile information (name, email, gender).
 *
 * @returns A 200-response with the userId the new user can use to contact the service.
 */
export const registerUser: Handler = async (event) => {
    const body = request(event);
    const userId = randomUUID();
    const user = {
        ...(await createUser(getUsername(userId))),
        userId,
        ...(body?.firstName && {firstName: body.firstName}),
        ...(body?.lastName && {lastName: body.lastName}),
        ...(body?.email && {email: body.email}),
        ...(body?.gender && {gender: body.gender}),
        ...(body?.birthdate && {birthdate: body.birthdate}),
        ...(body?.phone && {phone: body.phone})
    };

    await saveUser(user);

    return response(
        200,
        'application/json',
        JSON.stringify({userId})
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
 * @param event The event containing the request body with the userId parameter needed for the request.
 *
 * @return A 200-response with the ACS user id, access token and expiry time for the user requesting assistance.
 */
export const requestAssistance: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!isUUID(userId)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: userId' }));
    }

    console.info(`User ${userId} is requesting assistance`);
    const username = getUsername(userId);
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
 * @param event The event containing the request body with the userId parameter needed for the request.
 *
 * @return 200 if the assistance request was successfully updated, 404 if the assistance request was not found.
 */
export const awaitAssistance: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!isUUID(userId)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: userId' }));
    }

    console.info(`User ${userId} is waiting for assistance`);
    const username = getUsername(userId);
    const user = {username, ...(await getOrCreateCommunicationUserIdentifier(username))};
    const position = (await listAssistanceRequests())
        .findIndex(assistanceRequest => assistanceRequest.user.username === user.username);
    return await updateAssistanceRequest(user)
        ? response(200, 'application/json', JSON.stringify({position}))
        : response(404, 'application/json', JSON.stringify({message: 'Assistance request not found'}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Remove assistance request.
 *
 * This will delete the assistance request of the user. It is used by the client to clean up the assistance request
 * when the user hangs up while waiting.
 *
 * @param event The event containing the request body with the userId parameter needed for the request.
 *
 * @return 200 if the assistance request was successfully deleted, 404 if the assistance request was not found.
 */
export const cancelAssistance: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!isUUID(userId)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: userId' }));
    }

    console.info(`User ${userId} is giving up on getting assistance`);
    const username = getUsername(userId);
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
    const userToken = await getUserToken(
        username,
        ['voip'],
        {tokenExpiresInMinutes: ASSISTANCE_TOKEN_LIFETIME_MINUTES});
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
 * Create a single use file-upload url.
 *
 * This will create a signed url with a random key, allowing the end-user app to upload an image.
 *
 * @param _
 *
 * @return A 200-response with the new file key, the signed url and its expiration timestamp.
 */
export const createImageUploadUrl: Handler = async (_) => {
    const randomId = Math.floor(Math.random() * 10 ** UPLOAD_KEY_ID_LENGTH);
    const key = `${randomId.toString().padStart(8, "0")}.jpeg`;
    const expiresOn = (new Date(Date.now() + SIGNED_UPLOAD_URL_EXPIRATION_SECONDS * 1000)).toISOString();

    // Get signed url from S3.
    console.info(`Creating signed upload url for ${key} in bucket ${uploadBucket}, expiring ${expiresOn}.`);
    const uploadUrl = await s3.getSignedUrlPromise('putObject', {
        Bucket: uploadBucket,
        Key: key,
        Expires: SIGNED_UPLOAD_URL_EXPIRATION_SECONDS,
        ContentType: 'image/jpeg'
    });

    return response(200, 'application/json', JSON.stringify({uploadUrl, key, expiresOn}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Create a single use file-download url.
 * 
 * This will create a signed url for downloading the image with a given key.
 * 
 * @param event The event object containing the request body with the key parameter needed for the request.
 * 
 * @return A 200-response with the signed url and its expiration timestamp.
 */
export const createImageDownloadUrl: Handler = async (event) => {
    const key = request(event)?.key;
    const expiresOn = (new Date(Date.now() + SIGNED_DOWNLOAD_URL_EXPIRATION_SECONDS * 1000)).toISOString();

    if (!key) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: key' }));
    }

    // Get signed url from S3.
    console.info(`Creating signed download url for ${key} in bucket ${uploadBucket}, expiring ${expiresOn}.`);
    const downloadUrl = await s3.getSignedUrlPromise('getObject', {
        Bucket: uploadBucket,
        Key: key,
        Expires: SIGNED_DOWNLOAD_URL_EXPIRATION_SECONDS,
    });

    return response(200, 'application/json', JSON.stringify({downloadUrl, expiresOn}));
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

// noinspection JSUnusedGlobalSymbols
/**
 * Get user profile information.
 *
 * This endpoint retrieves an existing user's profile. For now, no authentication is required -
 * anyone with the userId can retrieve the profile.
 *
 * @param event The event containing the request body with userId parameter.
 *
 * @return A 200-response with the user data on success, 404-response if user not found, or 400-response if userId is missing.
 */
export const getUser: Handler = async (event) => {
    const body = request(event);
    const userId = body?.userId;

    if (!userId) {
        return response(400, 'application/json', JSON.stringify({error: 'Need parameter: userId'}));
    }

    const user = await getUserById(userId);
    if (!user) {
        return response(404, 'application/json', JSON.stringify({error: 'User not found'}));
    }

    return response(200, 'application/json', JSON.stringify({user}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Update user profile information.
 *
 * This endpoint allows updating an existing user's profile. For now, no authentication is required -
 * anyone with the userId can update the profile.
 *
 * The user must already exist (registered via registerUser endpoint). If an email is provided, it must not
 * be already registered by another user.
 *
 * @param event The event containing the request body with userId and profile fields to update.
 *
 * @return A 200-response on success, 404-response if user not found, or 400-response with error details if validation fails.
 */
export const updateUser: Handler = async (event) => {
    const body = request(event);
    const userId = body?.userId;

    if (!userId) {
        return response(400, 'application/json', JSON.stringify({error: 'Need parameter: userId'}));
    }

    //Get user by userId / check if exists
    const user = await getUserById(userId);
    if (!user) {
        return response(404, 'application/json', JSON.stringify({error: 'User not found'}));
    }

    const userNew = {
        username: user.username,
        communicationUserId: user.communicationUserId,
        ...(body?.firstName && {firstName: body.firstName}),
        ...(body?.lastName && {lastName: body.lastName}),
        ...(body?.email && {email: body.email}),
        ...(body?.gender && {gender: body.gender}),
        ...(body?.birthdate && {birthdate: body.birthdate}),
        ...(body?.phone && {phone: body.phone})
    } as User;

    // If profile data is provided, validate and check uniqueness
    if (userNew.email) {
        const existingUser = await getUserNameByEmail(userNew.email);
        if (existingUser && existingUser !== user.username) {
            return response(400, 'application/json', JSON.stringify({error: 'Email already registered'}));
        }
    }

    // Save the updated profile
    await saveUser(userNew);

    return response(200, 'application/json', JSON.stringify({}));
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

/** User profile functions **/

/**
 * Find a user by their email address.
 *
 * @param email  The normalized email address to search for.
 *
 * @return The username if found, undefined otherwise.
 */
const getUserNameByEmail = async (email: string): Promise<string | undefined> => {
    const result = await ddb.query({
        TableName: UsersTableName,
        IndexName: 'Email',
        KeyConditionExpression: 'Email = :email',
        ExpressionAttributeValues: {
            ':email': {S: email}
        },
        Limit: 1
    }).promise();

    return result.Items && result.Items.length > 0
        ? result.Items[0].Username?.S
        : undefined;
};

/**
 * Get user profile information from the database.
 *
 * @param userId The users ID
 *
 * @return The User for the user, or undefined ig the user doesn't exist

 */
const getUserById = async (userId: UUID): Promise<User | undefined> => {
    return getUserByName(getUsername(userId));
}

/**
 * Get user profile information from the database.
 *
 * @param username The users name
 *
 * @return The User for the user, or undefined ig the user doesn't exist

 */
const getUserByName = async (username: string): Promise<User | undefined> => {
    const item = (
        await ddb
            .getItem({
                TableName: UsersTableName,
                Key: {
                    Username: {S: username}
                }
            })
            .promise()
    ).Item;

    if (!item || !item.CommunicationUserId?.S || !item.Username?.S) {
        return undefined;
    }

    return {
        username: item.Username.S,
        communicationUserId: item.CommunicationUserId.S,
        ...(item.FirstName?.S && {firstName: item.firstName.S}),
        ...(item.LastName?.S && {lastName: item.lastName.S}),
        ...(item.email?.S && {email: item.email.S}),
        ...(item.Gender?.S && {gender: item.gender.S}),
        ...(item.Birthdate?.S && {birthdate: item.birthdate.S}),
        ...(item.Phone?.S && {phone: item.phone.S})
    } as User;
};

/**
 * Save or update user information in the database.
 *
 * @param user  The user.
 */
const saveUser = async (user: User): Promise<void> => {
    await ddb.putItem({
        TableName: UsersTableName,
        Item: {
            Username: {S: user.username},
            ...(user.firstName && {firstName: {S: user.firstName}}),
            ...(user.lastName && {lastName: {S: user.lastName}}),
            ...(user.email && {email: {S: user.email}}),
            ...(user.gender && {gender: {S: user.gender}}),
            ...(user.birthdate && {birthdate: {S: user.birthdate}}),
            ...(user.phone && {phone: {S: user.phone}})
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
                TableName: UsersTableName,
                Key: {
                    Username: { S: username }
                }
            })
            .promise()
    ).Item?.CommunicationUserId.S;
    return communicationUserId && { communicationUserId } || undefined;
};

/**
 * Create a new user, assign communication id, and add it to the database.
 *
 * @param username  The user to create a communication user identity for.
 *
 * @return The User for the user.
 */
const createUser = async (username: string): Promise<User> => {
    const user = await communicationIdentityClient.createUser();
    await ddb.putItem({
        TableName: UsersTableName,
        Item: {
            Username: { S: username },
            CommunicationUserId: { S: user.communicationUserId }
        }
    }).promise();
    return user as User;
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
    const result = existingId || await createUser(username);
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
    !holidays.includes(date) && hours && hours[(new Date(date)).getUTCDay()].map(x => x.map(y => date + "T" + y)),
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

/**
 * Get the username for a given UUID.
 *
 * End users currently do not need to create an account. Instead, each device will register for a random UUID when the
 * user first uses the service. Since we normally have human-readable usernames, we need to map this UUID to the actual
 * username to be used internally. Currently, this is done by just prefixing the UUID with the string "user_".
 *
 * @param uuid The UUID to calculate the username for.
 *
 * @returns The username to use for the user with the given UUID.
 */
const getUsername = (uuid: UUID) => 'user_' + uuid.toLowerCase();
