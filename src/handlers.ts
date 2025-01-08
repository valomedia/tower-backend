//
//  handlers.ts
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2023-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import https from 'https';
import {
    APIGatewayAuthorizerResult,
    APIGatewayTokenAuthorizerEvent,
    AuthResponse,
    Handler,
    StatementEffect
} from 'aws-lambda';
import { GetMeetingResponse, Meeting } from 'aws-sdk/clients/chime';
import { AzureKeyCredential } from '@azure/core-auth';
import { CommunicationUserIdentifier } from '@azure/communication-common';
import {
    CommunicationIdentityClient,
    GetTokenOptions,
    TokenScope
} from '@azure/communication-identity';
import { AssistanceRequest, User, UserToken } from './types';
import { AttributeMap, QueryInput } from 'aws-sdk/clients/dynamodb';
import { randomUUID } from 'crypto';

// Meetings with users waiting for an assistant to join.
const ddb = new AWS.DynamoDB();

// Read environment.
const currentRegion = process.env.REGION!;
const meetingsTableName = process.env.MEETINGS_TABLE_NAME!;
const assistanceRequestsTableName = process.env.ASSISTANCE_REQUESTS_TABLE_NAME!;
const callRecordsTableName = process.env.CALL_RECORDS_TABLE_NAME!;
const communicationUserIdsTableName = process.env.COMMUNICATION_USER_IDS_TABLE_NAME!;
const authUrl = process.env.AUTH_URL!;
const communicationServicesEndpoint = process.env.COMMUNICATION_SERVICES_ENDPOINT!;
const communicationServicesAccesskey = process.env.COMMUNICATION_SERVICES_ACCESSKEY!;

const chimeSDKMeetings = new AWS.ChimeSDKMeetings({region: currentRegion});

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

/*
 * Handlers
 */

// noinspection JSUnusedGlobalSymbols
/**
 * Return a success response.
 */
export const index: Handler = async (_) => {
    return response(200, 'application/json', JSON.stringify({message: 'Success'}));
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
 * @return 200 if the assistance request was successfully deleted, 404 if the assistance requset was not found.
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
 * Start a new assistance session.
 *
 * This will create a meeting for the user that made the request, add it to the queue to be picked up by an assistant
 * and create a new call record for the call.
 *
 * @param event The event object containing the requestContext, used to associate the new meeting with a user account.
 *
 * @return A 200-response with the information necessary to join the new meeting.
 */
export const start: Handler = async (event) => {
    const name = event.requestContext.authorizer.principalId;

    console.info(`Creating new meeting for user ${name} in region ${currentRegion}`);


    const meetingResponse = await createMeeting(name, currentRegion);

    await logNewCall(name, meetingResponse.Meeting!);

    // Add the meeting to the queue for an assistant to join.
    await enqueueMeeting(name, meetingResponse.Meeting!);

    // Create a new attendee for the meeting
    console.info(`Adding attendee ${name}`);
    const attendeeResponse = await createAttendee(meetingResponse.Meeting!, name);

    // Return the meeting and attendee responses. The client will use these to join the meeting.
    let startResponse = {
        joinInfo: {
            meetingResponse,
            attendeeResponse
        }
    };
    return response(200, 'application/json', JSON.stringify(startResponse, null, 2));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Join a call as an assistant.
 *
 * This will pop the first meeting from the queue and add the assistant that made the request to that meeting.
 *
 * @param event The event object containing the requestContext, used to associate the meeting with a user account.
 *
 * @return A 200-response with the information necessary to join the meeting, or a 404-response, if the queue is empty.
 */
export const join: Handler = async (event) => {
    const name = event.requestContext.authorizer.principalId;

    console.info(`Connecting assistant ${name} to a user`);

    const meetingInfo = await getMeeting();
    if (!meetingInfo || !meetingInfo.meetingResponse.Meeting) {
        console.info(`There is no meeting in the queue (presumably another assistant was faster to pick up).`);
        return response(404, 'application/json', JSON.stringify({ error: 'No meeting found' }));
    }

    await logAssistantJoin(meetingInfo.meetingResponse.Meeting, name);

    // Remove the meeting from the queue, now that an assistant has joined.
    await dequeueMeeting(meetingInfo.meetingTitle);

    // Create a new attendee for the meeting
    console.info(`Adding assistant ${name} to meeting for ${meetingInfo.meetingTitle}.`);
    const attendeeResponse = await createAttendee(meetingInfo.meetingResponse.Meeting, name);

    // Return the meeting and attendee responses. The client will use these to join the meeting.
    let joinResponse = {
        joinInfo: {
            meetingResponse: meetingInfo.meetingResponse,
            attendeeResponse
        }
    };
    return response(200, 'application/json', JSON.stringify(joinResponse, null, 2));
};

// noinspection JSUnusedGlobalSymbols
/**
 * End a given meeting.
 *
 * This will end the meeting specified by the meetingId query string parameter, hanging up all connections.
 *
 * @param event The event object containing the query string parameters.
 *
 * @return A 200-response if the meeting was ended, or a 400 response if no meeting id was specified.
 */
export const end: Handler = async (event) => {
    const query = event.queryStringParameters;
    if (!query || !query.meetingId) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: meetingId' }));
    }

    const meetingId = query.meetingId;
    try {
        const meetingResponse = await chimeSDKMeetings.getMeeting({MeetingId: meetingId}).promise();
        await endMeeting(meetingResponse.Meeting!);
        await logMeetingEnd(meetingResponse.Meeting!);
        return response(200, 'application/json', JSON.stringify({}));
    } catch (_) {
        return response(404, 'application/json', JSON.stringify({}))
    }

};

// noinspection JSUnusedGlobalSymbols
/**
 * Remove a given attendee from a given meeting.
 *
 * This will hang up the connection of the attendee specified by the attendeeId query string parameter, in the meeting
 * specified by the meetingId query string parameter. We currently don't store users, so the client needs to provide the
 * Chime attendee ID directly (since we have no easy way of finding an attendee from the external user ID).
 *
 * @param event The event object containing the query string parameters.
 *
 * @return A 200-response with an empty object on success, a 400-response if a parameter is missing.
 */
export const deleteAttendee: Handler = async (event) => {
    const query = event.queryStringParameters;
    if (!query || !query.attendeeId || !query.meetingId) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameters: attendeeId, meetingId' }));
    }

    const attendeeId = query.attendeeId;
    const meetingId = query.meetingId;
    const request = {
        MeetingId: meetingId,
        AttendeeId: attendeeId
    };
    console.debug('Deleting attendee: ' + JSON.stringify(request));

    await chimeSDKMeetings.deleteAttendee(request).promise();
    return response(200, 'application/json', JSON.stringify({}));
};

// noinspection JSUnusedGlobalSymbols
/**
 * Poll for users waiting to be assisted.
 *
 * @return A 200-response with a GetMeetingResponse, or a 404-response with an empty object.
 */
export const poll: Handler = async () => {
    const meetingInfo = await getMeeting();
    return response(meetingInfo ? 200 : 404, 'application/json', JSON.stringify(meetingInfo?.meetingResponse, null, 2));
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

/**
 * Get a meeting from the queue
 *
 * @return The title and GetMeetingResponse of the oldest queued meeting, if there is a meeting in the queue.
 */
const getMeeting = async (): Promise<{meetingTitle: string, meetingResponse: GetMeetingResponse}|undefined> => {
    console.debug('Finding oldest meeting in queue.');
    const queryOutput = await ddb.query({
        TableName: meetingsTableName,
        IndexName: 'DateTime',
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeValues: {
            ':pk': { S: '1' }
        },
        ExpressionAttributeNames: {
            '#pk': "PartitionKey"
        },
        Limit: 1
    }).promise();
    if (!queryOutput.Items?.length) { return; }
    const meetingId = queryOutput.Items![0].Data.S!;
    const meetingTitle = queryOutput.Items![0].Title.S!;
    console.debug(`User ${meetingTitle} is first in line.`);

    try {
        const meetingResponse = await chimeSDKMeetings.getMeeting({MeetingId: meetingId}).promise();
        console.debug('Got meeting: ' + JSON.stringify(meetingResponse));
        return {
            meetingTitle,
            meetingResponse
        };
    } catch (_) {
        console.debug('Meeting no longer exists (user hung up while waiting), dequeueing and getting another one.');
        await dequeueMeeting(meetingTitle);
        return await getMeeting();
    }
};

/**
 * Store a meeting in the database of meetings waiting for an assistant.
 *
 * @param title     The title under which to file the meeting.
 * @param meeting   The meeting to store.
 */
const enqueueMeeting = async (title: string, meeting: Meeting) => {
    await ddb.putItem({
        TableName: meetingsTableName,
        Item: {
            Title: { S: title },
            PartitionKey: { S: "1" },
            DateTime: { S: (new Date()).toISOString() },
            Data: { S: meeting.MeetingId },

            // Set time-to-live to one day, causing the meeting record to be cleaned up automatically after 24 hours.
            TTL: { N: `${Math.floor(Date.now() / 1000) + 60 * 60 * 24}`}
        }
    }).promise();
};

/**
 * Create a new call record with the username of the caller and the time the call was started.
 *
 * @param caller    The username of the caller to log in the call record.
 * @param meeting   The Meeting the user is in, used as an index to allow updating the record during the call lifecycle.
 */
const logNewCall = async (caller: string, meeting: Meeting) => {
    await ddb.putItem({
        TableName: callRecordsTableName,
        Item: {
            Caller: { S: caller },
            StartDateTime: { S: (new Date()).toISOString() },
            Meeting: { S: meeting.MeetingId }
        }
    }).promise();
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
 * Update a call record with the username of the assistant that accepted the call and the time the assistant joined.
 *
 * @param meeting   The Meeting the assistant is joining, used to find the call record to update.
 * @param assistant The username of the assistant that picked up the call.
 */
const logAssistantJoin = async (meeting: Meeting, assistant: string) => {
    await ddb.updateItem({
        TableName: callRecordsTableName,
        Key: {
            Meeting: {S: meeting.MeetingId}
        },
        UpdateExpression: "SET Assistant = :assistant, AcceptDateTime = :acceptDateTime",
        ExpressionAttributeValues: {
            ":assistant": {S: assistant},
            ":acceptDateTime": {S: (new Date()).toISOString()}
        }
    }).promise();
};

/**
 * Update a call record with the time the call ended.
 *
 * @param meeting   The meeting that is ending, used to find the call record to update.
 */
const logMeetingEnd = async (meeting: Meeting) => {
    await ddb.updateItem({
        TableName: callRecordsTableName,
        Key: {
            Meeting: {S: meeting.MeetingId}
        },
        UpdateExpression: "SET EndDateTime = :endDateTime",
        ExpressionAttributeValues: {
            ":endDateTime": {S: (new Date()).toISOString()}
        }
    }).promise();
};

/**
 * Remove a meeting from the database of meetings waiting for an assistant.
 *
 * @param title The title of the meeting to dequeue.
 */
const dequeueMeeting = async (title: string) => {
    await ddb.deleteItem({
        TableName: meetingsTableName,
        Key: {
            Title: { S: title }
        }
    }).promise();
};

/**
 * Create a meeting and store it in the database.
 *
 * @param title     The title of the meeting, the first 64 characters of which get used as the external meeting id.
 * @param region    The physical data center region where the meeting is hosted.
 *
 * @return The new meeting.
 */
const createMeeting = async (title: string, region: string) => {
    let request = {
        // Use a UUID for the client request token to ensure that any request retries do not create multiple
        // meetings.
        ClientRequestToken: uuidv4(),

        // Specify the media region (where the meeting is hosted). In this case, we use the region selected by the
        // user.
        MediaRegion: region,

        // Our external ID for the meeting. For simplicity, this is just the meeting title right now.
        ExternalMeetingId: title.substring(0, 64)
    };
    console.debug('Creating meeting: ' + JSON.stringify(request));

    const meetingResponse = await chimeSDKMeetings.createMeeting(request).promise();
    console.debug('Created meeting: ' + JSON.stringify(meetingResponse));

    return meetingResponse;
};

/**
 * End a given meeting, all attendee connections will hang up.
 *
 * @param meeting   The meeting to end.
 */
const endMeeting = async (meeting: Meeting) => {
    console.debug(`Ending meeting: ${meeting.MeetingId}`);
    await chimeSDKMeetings.deleteMeeting({ MeetingId: meeting.MeetingId!}).promise();
};

/**
 * Create an attendee with a given name for a given meeting.
 *
 * @param meeting   The meeting to add an attendee to.
 * @param name      The name of the new attendee (not currently used for anything).
 *
 * @return The CreateAttendeeResponse for the new attendee.
 */
const createAttendee = async (meeting: Meeting, name: string) => {
    const request = {
        // The meeting ID of the created meeting to add the attendee to
        MeetingId: meeting.MeetingId!,

        // Our external ID for the user. For simplicity, this is just for random hex bytes, followed by the username
        // for now.
        ExternalUserId: `${uuidv4().substring(0, 8)}#${name}`.substring(0, 64)
    };
    console.debug('Creating attendee: ' + JSON.stringify(request));

    const attendeeResponse = await chimeSDKMeetings.createAttendee(request).promise();
    console.debug('Created attendee: ' + JSON.stringify(attendeeResponse));

    return attendeeResponse;
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

const response = (statusCode: number, contentType: string, body: any, isBase64Encoded = false) => ({
    statusCode: statusCode,
    headers: {'Content-Type': contentType,},
    body: body,
    isBase64Encoded
});
