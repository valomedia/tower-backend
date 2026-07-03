//
//  handlers.ts
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2023-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

import {
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    QueryCommandInput,
    UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import https from 'https';
import {
    APIGatewayAuthorizerResult,
    APIGatewayTokenAuthorizerEvent,
    AuthResponse,
    Handler,
    StatementEffect
} from 'aws-lambda';
import { AzureKeyCredential } from '@azure/core-auth';
import {
    CommunicationIdentityClient,
    GetTokenOptions,
    TokenScope
} from '@azure/communication-identity';
import {AssistanceRequest, User, UserProfile, UserToken} from './types';
import {
    assistanceRequestFromItem,
    calculateOpeningHours,
    isUUID,
    isValidEmail,
    request,
    response,
    userFromItem,
    userIdToUsername
} from './helpers';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION! });
const s3 = new S3Client({ region: process.env.AWS_REGION! });
const ses = new SESv2Client({ region: process.env.AWS_REGION! });

// Read environment.
const assistanceRequestsTableName = process.env.ASSISTANCE_REQUESTS_TABLE_NAME!;
const callRecordsTableName = process.env.CALL_RECORDS_TABLE_NAME!;
const communicationUserIdsTableName = process.env.COMMUNICATION_USER_IDS_TABLE_NAME!;
const userProfilesTableName = process.env.USER_PROFILES_TABLE_NAME!;
const authUrl = process.env.AUTH_URL!;
const communicationServicesEndpoint = process.env.COMMUNICATION_SERVICES_ENDPOINT!;
const communicationServicesAccesskey = process.env.COMMUNICATION_SERVICES_ACCESSKEY!;
const mailFromAddress = process.env.MAIL_FROM_ADDRESS;
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

const ASSISTANCE_REQUESTS_BY_AGE_QUERY: QueryCommandInput = {
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

const calculateConfiguredOpeningHours = (date: string): Date[][] =>
    calculateOpeningHours(date, {hours, extraHours, holidays});

/*
 * Handlers
 */

// noinspection JSUnusedGlobalSymbols
/**
 * Return a success response.
 */
export const indexHandler: Handler = async (_) => {
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
    const openingHours = dates.map(calculateConfiguredOpeningHours);

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
 * @returns A 200-response with the userId of the new user or a 400-response if the email is taken.
 */
export const registerUserHandler: Handler = async (event) => {
    const body = request(event);
    const userId = randomUUID();
    const username = userIdToUsername(userId);

    if (body?.email) {
        if (!isValidEmail(body.email)) {
            return response(400, 'application/json', JSON.stringify({error: 'Invalid email address'}));
        }
        if (await getUsernameByEmail(body.email)) {
            return response(400, 'application/json', JSON.stringify({error: 'Email already registered'}));
        }
        try {
            await sendEmailConfirmation(body.email);
        } catch (err) {
            console.error('Failed to send confirmation email', err);
            return response(500, 'application/json', JSON.stringify({error: 'Failed to send confirmation email'}));
        }
    }

    await createUser({...body, username});

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
export const requestAssistanceHandler: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!isUUID(userId)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: userId' }));
    }

    console.info(`User ${userId} is requesting assistance`);
    const username = userIdToUsername(userId);
    const userToken = await getUserToken(
        await getOrCreateUser(username),
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
export const awaitAssistanceHandler: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!isUUID(userId)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: userId' }));
    }

    console.info(`User ${userId} is waiting for assistance`);
    const username = userIdToUsername(userId);
    const user = await getOrCreateUser(username);
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
export const cancelAssistanceHandler: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!isUUID(userId)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: userId' }));
    }

    console.info(`User ${userId} is giving up on getting assistance`);
    const username = userIdToUsername(userId);
    const assistanceRequest = await deleteAssistanceRequest({username});
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
export const assistanceTokenHandler: Handler = async (event) => {
    const username = event.requestContext.authorizer.principalId;
    const userToken = await getUserToken(
        await getOrCreateUser(username),
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
export const offerAssistanceHandler: Handler = async (_) => {
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
export const beginAssistanceHandler: Handler = async (event) => {
    const assistant = event.requestContext.authorizer.principalId;

    const assistanceRequest = await popAssistanceRequest();
    if (!assistanceRequest) {
        console.info(`There is no meeting in the queue (presumably another assistant was faster to pick up).`);
        return response(404, 'application/json', JSON.stringify({message: 'No meeting found'}));
    }
    const user = await getOrCreateUser(assistanceRequest.user.username);

    console.info(`Assistant ${assistant} will assist ${assistanceRequest.user.username}`);
    const meeting = await logAssistance(user.username, assistant, assistanceRequest.startDateTime, new Date());
    return response(200, 'application/json', JSON.stringify({meeting, assistanceRequest: {...assistanceRequest, user}}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * End an assistance call.
 *
 * This records when an answered assistance call ended and whether the call should count towards billable usage.
 * The staff app passes the meeting id returned by /beginAssistance. Calls are scoped to the authenticated assistant,
 * so one assistant cannot end another assistant's call record.
 *
 * @param event The event containing the request body with the meeting id and optional nonBillable flag.
 *
 * @return A 200-response if the call was ended, 404 if no matching open call exists.
 */
export const endAssistanceHandler: Handler = async (event) => {
    const assistant = event.requestContext.authorizer.principalId;
    const body = request(event);
    const meeting = body?.meeting;
    const nonBillable = body?.nonBillable;

    if (!isUUID(meeting)) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: meeting' }));
    }
    if (nonBillable !== undefined && typeof nonBillable !== 'boolean') {
        return response(400, 'application/json', JSON.stringify({ error: 'Parameter nonBillable must be a boolean' }));
    }

    console.info(`Assistant ${assistant} ended meeting ${meeting}`);
    return await logAssistanceEnd(meeting, assistant, new Date(), nonBillable !== true)
        ? response(200, 'application/json', '{}')
        : response(404, 'application/json', JSON.stringify({message: 'Open meeting not found'}));
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
export const createImageUploadUrlHandler: Handler = async (_) => {
    const randomId = Math.floor(Math.random() * 10 ** UPLOAD_KEY_ID_LENGTH);
    const key = `${randomId.toString().padStart(8, "0")}.jpeg`;
    const expiresOn = (new Date(Date.now() + SIGNED_UPLOAD_URL_EXPIRATION_SECONDS * 1000)).toISOString();

    // Get signed url from S3.
    console.info(`Creating signed upload url for ${key} in bucket ${uploadBucket}, expiring ${expiresOn}.`);
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
        Bucket: uploadBucket,
        Key: key,
        ContentType: 'image/jpeg'
    }), { expiresIn: SIGNED_UPLOAD_URL_EXPIRATION_SECONDS });

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
export const createImageDownloadUrlHandler: Handler = async (event) => {
    const key = request(event)?.key;
    const expiresOn = (new Date(Date.now() + SIGNED_DOWNLOAD_URL_EXPIRATION_SECONDS * 1000)).toISOString();

    if (!key) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: key' }));
    }

    // Get signed url from S3.
    console.info(`Creating signed download url for ${key} in bucket ${uploadBucket}, expiring ${expiresOn}.`);
    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: uploadBucket,
        Key: key,
    }), { expiresIn: SIGNED_DOWNLOAD_URL_EXPIRATION_SECONDS });

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
export const authHandler: Handler = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
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
export const getUserHandler: Handler = async (event) => {
    const userId = request(event)?.userId;
    if (!userId) {
        return response(400, 'application/json', JSON.stringify({error: 'Need parameter: userId'}));
    }

    const user = await getUser(userIdToUsername(userId));
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
export const updateUserHandler: Handler = async (event) => {
    const body = request(event);
    const userId = body?.userId;

    if (!body || !userId) {
        return response(400, 'application/json', JSON.stringify({error: 'Need parameter: userId'}));
    }

    //Get user by userId / check if exists
    const user = await getUser(userIdToUsername(userId));
    if (!user) {
        return response(404, 'application/json', JSON.stringify({error: 'User not found'}));
    }

    // If profile data is provided, validate and check uniqueness
    if (body.email) {
        if (!isValidEmail(body.email)) {
            return response(400, 'application/json', JSON.stringify({error: 'Invalid email address'}));
        }
        const existingUser = await getUsernameByEmail(body.email);
        if (existingUser && existingUser !== user.username) {
            return response(400, 'application/json', JSON.stringify({error: 'Email already registered'}));
        }
        if (body.email !== user.email) {
            try {
                await sendEmailConfirmation(body.email);
            } catch (err) {
                console.error('Failed to send confirmation email', err);
                return response(500, 'application/json', JSON.stringify({error: 'Failed to send confirmation email'}));
            }
        }
    }

    // Save the updated profile
    await updateUserProfile({...body, username: user.username});

    return response(200, 'application/json', JSON.stringify({}));
};

/*
 * Helpers
 */

const calculateAssistanceRequestTtl = () => {
    // Set time-to-live to two minutes, causing stale requests to be automatically removed.
    return { N: `${Math.floor(Date.now() / 1000) + ASSISTANCE_REQUEST_KEEPALIVE_TIMEOUT_SECONDS }`};
};

// noinspection JSUnusedLocalSymbols
const listAssistanceRequests = async (): Promise<AssistanceRequest[]> => {
    const queryOutput = await ddb.send(new QueryCommand(ASSISTANCE_REQUESTS_BY_AGE_QUERY));
    return (queryOutput.Items || []).map(assistanceRequestFromItem).filter((x): x is AssistanceRequest => !!x);
};

const getAssistanceRequest = async (user : User|undefined = undefined): Promise<AssistanceRequest|undefined> => {
    const item = user
        ? (
            await ddb.send(new GetItemCommand({
                TableName: assistanceRequestsTableName,
                Key: {
                    Username: {S: user.username}
                }
            }))
        ).Item
        : (await ddb.send(new QueryCommand({...ASSISTANCE_REQUESTS_BY_AGE_QUERY, Limit: 1}))).Items?.at(0);
    if (!item) {return;}
    const assistanceRequest = assistanceRequestFromItem(item);
    if (!assistanceRequest) {await deleteAssistanceRequest({username: item.Username?.S!})}
    return assistanceRequestFromItem(item) || getAssistanceRequest(user);
};

const createAssistanceRequest = async (user: User, startDateTime: Date = new Date()): Promise<AssistanceRequest> => {
    await ddb.send(new PutItemCommand({
        TableName: assistanceRequestsTableName,
        Item: {
            Username: {S: user.username},
            PartitionKey: {S: "1"},
            DateTime: {S: startDateTime.toISOString()},
            TTL: calculateAssistanceRequestTtl()
        }
    }));
    return {user, startDateTime}
};

const updateAssistanceRequest = async (user: User): Promise<AssistanceRequest|undefined> => {
    const assistanceRequest = await getAssistanceRequest(user);
    if (!assistanceRequest) {return;}
    return createAssistanceRequest(user, assistanceRequest.startDateTime);
};

const deleteAssistanceRequest = async ({username}: {username: string}): Promise<AssistanceRequest|undefined> => {
    const result = await ddb.send(new DeleteItemCommand({
        TableName: assistanceRequestsTableName,
        ReturnValues: "ALL_OLD",
        Key: {
            Username: {S: username}
        }
    }));
    if (!result.Attributes) {return;}
    return assistanceRequestFromItem(result.Attributes);
};

const popAssistanceRequest = async (): Promise<AssistanceRequest|undefined> => {
    const assistanceRequest = await getAssistanceRequest();
    if (!assistanceRequest) {return;}
    return (await deleteAssistanceRequest(assistanceRequest.user))
        ? assistanceRequest
        : popAssistanceRequest();
};

const logAssistance = async (caller: string, assistant: string, startDateTime: Date, acceptDateTime: Date): Promise<string> => {
    const meeting = randomUUID();
    await ddb.send(new PutItemCommand({
        TableName: callRecordsTableName,
        Item: {
            Caller: {S: caller},
            Assistant: {S: assistant},
            StartDateTime: {S: startDateTime.toISOString()},
            AcceptDateTime: {S: acceptDateTime.toISOString()},
            Billable: {BOOL: true},
            Meeting: {S: meeting}
        }
    }));
    return meeting;
};

const logAssistanceEnd = async (
    meeting: string,
    assistant: string,
    endDateTime: Date,
    billable: boolean
): Promise<boolean> => {
    try {
        await ddb.send(new UpdateItemCommand({
            TableName: callRecordsTableName,
            Key: {
                Meeting: {S: meeting}
            },
            UpdateExpression: 'SET EndDateTime = :endDateTime, Billable = :billable',
            ConditionExpression: 'attribute_exists(Meeting) AND Assistant = :assistant AND attribute_not_exists(EndDateTime)',
            ExpressionAttributeValues: {
                ':endDateTime': {S: endDateTime.toISOString()},
                ':billable': {BOOL: billable},
                ':assistant': {S: assistant}
            }
        }));
        return true;
    } catch (err) {
        if (typeof err === 'object' && err !== null && 'name' in err
            && err.name === 'ConditionalCheckFailedException') {
            return false;
        }
        throw err;
    }
};

const logAbandonment = async (caller: string, startDateTime: Date, endDateTime: Date) => {
    await ddb.send(new PutItemCommand({
        TableName: callRecordsTableName,
        Item: {
            Caller: {S: caller},
            StartDateTime: {S: startDateTime.toISOString()},
            EndDateTime: {S: endDateTime.toISOString()},
            Billable: {BOOL: false},
            Meeting: {S: randomUUID()}
        }
    }));
};

/**
 * Send a confirmation e-mail to a user who has just added or changed their e-mail address.
 *
 * If no from-address is configured, sending is silently skipped (allowing deployments to opt out of e-mail entirely).
 * Otherwise, any failure from SES is propagated to the caller, so the calling handler can decide how to surface it.
 *
 * @param recipient  The address to send the confirmation to.
 */
const sendEmailConfirmation = async (recipient: string): Promise<void> => {
    if (!mailFromAddress) {
        console.warn('MAIL_FROM_ADDRESS is not configured; skipping confirmation e-mail');
        return;
    }
    await ses.send(new SendEmailCommand({
        FromEmailAddress: mailFromAddress,
        Destination: { ToAddresses: [recipient] },
        Content: {
            Simple: {
                Subject: { Data: 'Deine E-Mail-Adresse wurde verknüpft', Charset: 'UTF-8' },
                Body: {
                    Text: {
                        Data:
                            'Hallo,\n\n' +
                            'deine E-Mail-Adresse wurde mit einem Tower-Profil verknüpft.\n\n' +
                            'Falls du das nicht warst, melde dich bitte unter webmaster@tower-assist.de.\n\n' +
                            'Viele Grüße\n' +
                            'Dein Tower-Team\n',
                        Charset: 'UTF-8'
                    }
                }
            }
        }
    }));
};

/**
 * Find a user by their email address.
 *
 * @param email  The normalized email address to search for.
 *
 * @return The username if found, undefined otherwise.
 */
const getUsernameByEmail = async (email: string): Promise<string | undefined> => {
    const result = await ddb.send(new QueryCommand({
        TableName: userProfilesTableName,
        IndexName: 'Email',
        KeyConditionExpression: 'Email = :email',
        ExpressionAttributeValues: {
            ':email': {S: email}
        },
        Limit: 1
    }));

    return result.Items && result.Items.length > 0
        ? result.Items[0].Username?.S
        : undefined;
};

/**
 * Get a User from the database.
 *
 * @param username The username of the User to return.
 *
 * @return The User, or undefined if the User doesn't exist.
 */
const getUser = async (username: string): Promise<User|undefined> => {
    const [profileItem, commItem] = await Promise.all([
        ddb.send(new GetItemCommand({TableName: userProfilesTableName, Key: {Username: {S: username}}})),
        ddb.send(new GetItemCommand({TableName: communicationUserIdsTableName, Key: {Username: {S: username}}})),
    ]);
    return userFromItem({...profileItem.Item, ...commItem.Item});
};

/**
 * Create or update user profile information in the database.
 *
 * @param profile  The UserProfile to save.
 */
const updateUserProfile = async (profile: UserProfile): Promise<void> => {
    await ddb.send(new PutItemCommand({
        TableName: userProfilesTableName,
        Item: {
            Username: {S: profile.username},
            ...(profile.firstName && {FirstName: {S: profile.firstName}}),
            ...(profile.lastName && {LastName: {S: profile.lastName}}),
            ...(profile.email && {Email: {S: profile.email}}),
            ...(profile.gender && {Gender: {S: profile.gender}}),
            ...(profile.birthdate && {Birthdate: {S: profile.birthdate}}),
            ...(profile.phone && {Phone: {S: profile.phone}})
        }
    }));
};

/**
 * Create a new user, assign communication id, and add it to the database.
 *
 * @param profile  The profile information for the new user.
 *
 * @return The created User.
 */
const createUser = async (profile: UserProfile): Promise<User> => {
    const user = {...await communicationIdentityClient.createUser(), ...profile};
    await ddb.send(new PutItemCommand({
        TableName: communicationUserIdsTableName,
        Item: {
            Username: { S: user.username },
            CommunicationUserId: { S: user.communicationUserId }
        }
    }));
    await updateUserProfile(user);
    return user;
};

/**
 * Get a user from the database, creating it, if it does not exist yet.
 *
 * @param username  The user to get or create.
 *
 * @return The requested User.
 */
const getOrCreateUser = async (username: string) =>
    (await getUser(username)) || (await createUser({username}));

/**
 * Get an access token for a customer.
 *
 * @param user      The user to get an access token for.
 * @param scopes    Scopes to include in the token.
 * @param options   Additional options for the token (used for setting expiry time).
 *
 * @return The access token for the customer.
 */
const getUserToken = async (user: User, scopes: TokenScope[], options?: GetTokenOptions): Promise<UserToken> => {
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
