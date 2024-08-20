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
import { AuthResponse, Handler, StatementEffect } from 'aws-lambda';
import { GetMeetingResponse, Meeting } from 'aws-sdk/clients/chime';

// Meetings with users waiting for an assistant to join.
const ddb = new AWS.DynamoDB();

// Read environment.
const currentRegion = process.env.REGION!;
const meetingsTableName = process.env.MEETINGS_TABLE_NAME!;
const callRecordsTableName = process.env.CALL_RECORDS_TABLE_NAME!;
const authUrl = process.env.AUTH_URL!;

const chimeSDKMeetings = new AWS.ChimeSDKMeetings({region: currentRegion});

/*
 * Handlers
 */

// noinspection JSUnusedGlobalSymbols
/**
 * Return a success response.
 */
export const index: Handler = async () => {
    return response(200, 'application/json', JSON.stringify({ message: 'Success' }));
}

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
    }
    return response(200, 'application/json', JSON.stringify(startResponse, null, 2));
}

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
    }
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

    await endMeeting(meetingId);
    return response(200, 'application/json', JSON.stringify({}));
}

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
    }
    console.debug('Deleting attendee: ' + JSON.stringify(request));

    await chimeSDKMeetings.deleteAttendee(request).promise();
    return response(200, 'application/json', JSON.stringify({}));
}

// noinspection JSUnusedGlobalSymbols
/**
 * Poll for users waiting to be assisted.
 *
 * @return A 200-response with a GetMeetingResponse, or a 404-response with an empty object.
 */
export const poll: Handler = async () => {
    const meetingInfo = await getMeeting();
    return response(meetingInfo ? 200 : 404, 'application/json', JSON.stringify(meetingInfo?.meetingResponse, null, 2));
}

// noinspection JSUnusedGlobalSymbols
/**
 * Authorize the request based on basic authentication.
 *
 * This will throw a request's authorization token against the auth url, authorizing the request, if the response has a
 * HTTP status code of 200.
 *
 * @param event     The event object containing the authorization token from the request.
 * @param _
 * @param callback  A callback, that will either be invoked with an error string, or with null and an AuthResponse.
 */
export const auth: Handler = function(event, _, callback) {
    const token = event.authorizationToken;
    const principalId = Buffer.from(token.split(' ')[1], 'base64').toString('utf-8').split(':')[0];

    https
        .request(
            authUrl,
            {
                method: 'HEAD',
                headers: { authorization: token }
            },
            (res) => {
                if (res.statusCode === 200) {
                    callback(null, generatePolicy(principalId, 'Allow'));
                } else {
                    callback('Unauthorized');
                }
            }
        )
        .on('error', (_) => callback('Error: Internal Server Error'))
        .end();
}

/*
 * Helpers
 */

/**
 * Get a meeting from the queue
 *
 * @return The title and GetMeetingResponse of the oldest queued meeting, if there is a meeting in the queue.
 */
async function getMeeting(): Promise<{meetingTitle: string, meetingResponse: GetMeetingResponse}|undefined> {
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
}

/**
 * Store a meeting in the database of meetings waiting for an assistant.
 *
 * @param title     The title under which to file the meeting.
 * @param meeting   The meeting to store.
 */
async function enqueueMeeting(title: string, meeting: Meeting) {
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
}

/**
 * Create a new call record with the username of the caller and the time the call was started.
 *
 * @param caller    The username of the caller to log in the call record.
 * @param meeting   The Meeting the user is in, used as an index to allow updating the record during the call lifecycle.
 */
async function logNewCall(caller: string, meeting: Meeting) {
    await ddb.putItem({
        TableName: callRecordsTableName,
        Item: {
            Caller: { S: caller },
            StartDateTime: { S: (new Date()).toISOString() },
            Meeting: { S: meeting.MeetingId }
        }
    }).promise();
}

/**
 * Update a call record with the username of the assistant that accepted the call and the time the assistant joined.
 *
 * @param meeting   The Meeting the assistant is joining, used to find the call record to update.
 * @param assistant The username of the assistant that picked up the call.
 */
async function logAssistantJoin(meeting: Meeting, assistant: string) {
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
}

/**
 * Remove a meeting from the database of meetings waiting for an assistant.
 *
 * @param title The title of the meeting to dequeue.
 */
async function dequeueMeeting(title: string) {
    await ddb.deleteItem({
        TableName: meetingsTableName,
        Key: {
            Title: { S: title }
        }
    }).promise();
}

/**
 * Create a meeting and store it in the database.
 *
 * @param title     The title of the meeting, the first 64 characters of which get used as the external meeting id.
 * @param region    The physical data center region where the meeting is hosted.
 *
 * @return The new meeting.
 */
async function createMeeting(title: string, region: string){
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
}

/**
 * End a given meeting, all attendee connections will hang up.
 *
 * @param meetingId The chime meeting id (not the title) of the meeting to end.
 */
async function endMeeting(meetingId: string) {
    console.debug(`Ending meeting: ${meetingId}`);
    await chimeSDKMeetings.deleteMeeting({ MeetingId: meetingId }).promise();
}

/**
 * Create an attendee with a given name for a given meeting.
 *
 * @param meeting   The meeting to add an attendee to.
 * @param name      The name of the new attendee (not currently used for anything).
 *
 * @return The CreateAttendeeResponse for the new attendee.
 */
async function createAttendee(meeting: Meeting, name: string) {
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
}

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
function generatePolicy(principalId: string, effect: StatementEffect): AuthResponse {
    const authResponse = {
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
    };

    console.log('Generated policy: ' + JSON.stringify(authResponse));
    return authResponse;
}

function response(statusCode: number, contentType: string, body: any, isBase64Encoded = false) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': contentType,
        },
        body: body,
        isBase64Encoded
    };
}
