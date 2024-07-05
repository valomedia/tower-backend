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

exports.start = async (event: any) => {
    const name = event.requestContext.authorizer.principalId;

    console.info(`Creating new meeting for user ${name} in region ${currentRegion}`);

    const meetingResponse = await createMeeting(name, currentRegion);

    // Add the meeting to the queue for an assistant to join.
    await enqueueMeeting(name, meetingResponse.Meeting);

    // Create a new attendee for the meeting
    console.info(`Adding attendee ${name}`);
    const attendeeResponse = await createAttendee(meetingResponse.Meeting, name);

    // Return the meeting and attendee responses. The client will use these to join the meeting.
    let startResponse = {
        joinInfo: {
            meetingResponse,
            attendeeResponse
        }
    }
    return response(200, 'application/json', JSON.stringify(startResponse, null, 2));
}

exports.join = async (event: any) => {
    const name = event.requestContext.authorizer.principalId;

    console.info(`Connecting assistant ${name} to a user`);

    const meetingResponse = await getMeeting();

    if (!meetingResponse.Meeting) {
        console.info(`There is no meeting in the queue (presumably another assistant was faster to pick up).`);
        return response(404, 'application/json', JSON.stringify({ error: 'No meeting found' }));
    }

    // Remove the meeting from the queue, now that an assistant has joined.
    await dequeueMeeting(meetingResponse.Meeting.ExternalMeetingId);

    // Create a new attendee for the meeting
    console.info(`Adding assistant ${name} to meeting for ${meetingResponse.Meeting.ExternalMeetingId}.`);
    const attendeeResponse = await createAttendee(meetingResponse.Meeting, name);

    // Return the meeting and attendee responses. The client will use these to join the meeting.
    let joinResponse = {
        joinInfo: {
            meetingResponse,
            attendeeResponse
        }
    }
    return response(200, 'application/json', JSON.stringify(joinResponse, null, 2));
};

exports.end = async (event: any) => {
    const query = event.queryStringParameters;
    if (!query || !query.meetingId) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: meetingId' }));
    }

    const meetingId = query.meetingId;

    await endMeeting(meetingId);
    return response(200, 'application/json', JSON.stringify({}));
}

exports.deleteAttendee = async (event: any) => {
    const query = event.queryStringParameters;
    if (!query || !query.attendeeId || !query.meetingId) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameters: attendeeId, meetingId' }));
    }

    const attendeeId = query.attendeeId;
    const meetingId = query.meetingId;

    await deleteAttendee(attendeeId, meetingId);
    return response(200, 'application/json', JSON.stringify({}));
}

exports.poll = async (_: any) => {
    const meetingResponse = await getMeeting();
    return response(meetingResponse.Meeting ? '200' : '404', 'application/json', JSON.stringify(meetingResponse, null, 2));
}

exports.auth = function(event: any, _: any, callback: any) {
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

/*
 * Retrieve a meeting ID from the meeting table using its externalMeetingId.
 *
 * This just looks up the meeting ID in the database. If the meeting has ended, the result might be a stale ID for a
 * meeting that no longer exists. The caller is expected to check whether the meeting actually exists before proceeding
 * to use the meeting ID for anything.
 */
// noinspection JSUnusedLocalSymbols
async function getMeetingId(title: any) {
    const result = await ddb.getItem({
        TableName: meetingsTableName,
        Key: {
            'Title': { S: title }
        }
    }).promise();
    return result.Item ? result.Item.Data.S : null;
}

/*
 * Get a meeting from the queue
 *
 * This will return the oldest meeting in the queue, or an empty object, if the queue is empty.
 */
async function getMeeting(): Promise<any> {
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
    if (!queryOutput.Items!.length) { return {}; }
    const meetingId = queryOutput.Items![0].Data.S!;
    const meetingTitle = queryOutput.Items![0].Title.S!;

    console.debug(`User ${meetingTitle} is first in line.`);
    const meetingResponse = await chimeSDKMeetings
        .getMeeting({ MeetingId: meetingId })
        .promise()
        .catch(async _ => {
            console.debug('Meeting no longer exists (user hung up while waiting), dequeueing and getting another one.');
            await dequeueMeeting(meetingTitle);
            return await getMeeting();
        });
    console.debug('Got meeting: ' + JSON.stringify(meetingResponse));

    return meetingResponse;
}

/*
 * Store a meeting in the database of meetings waiting for an assistant.
 */
async function enqueueMeeting(title: any, meeting: any) {
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

/*
 * Remove a meeting from the database of meetings waiting for an assistant.
 */
async function dequeueMeeting(title: any) {
    await ddb.deleteItem({
        TableName: meetingsTableName,
        Key: {
            Title: { S: title }
        }
    }).promise();
}

/*
 * Create a meeting and store it in the database.
 */
async function createMeeting(title: any, region: any){
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

/*
 * End a given meeting.
 *
 * All attendee connections will hang up.
 */
async function endMeeting(meetingId: any) {
    console.debug(`Ending meeting: ${meetingId}`);
    await chimeSDKMeetings.deleteMeeting({ MeetingId: meetingId }).promise();
}

/*
 * Create an attendee with a given name for a given meeting.
 */
async function createAttendee(meeting: any, name: any) {
    const request = {
        // The meeting ID of the created meeting to add the attendee to
        MeetingId: meeting.MeetingId,

        // Our external ID for the user. For simplicity, this is just for random hex bytes, followed by the username
        // for now.
        ExternalUserId: `${uuidv4().substring(0, 8)}#${name}`.substring(0, 64)
    };
    console.debug('Creating attendee: ' + JSON.stringify(request));

    const attendeeResponse = await chimeSDKMeetings.createAttendee(request).promise();
    console.debug('Created attendee: ' + JSON.stringify(attendeeResponse));

    return attendeeResponse;
}

/*
 * Delete an attendee with a given ID from a given meeting.
 *
 * Delete the attendee.  We currently don't store users, so the client needs to provide the Chime attendee ID directly
 * (since we have no easy way of finding an attendee from the external user ID).
 */
async function deleteAttendee(attendeeId: any, meetingId: any) {
    const request = {
        MeetingId: meetingId,
        AttendeeId: attendeeId
    }
    console.debug('Deleting attendee: ' + JSON.stringify(request));
    await chimeSDKMeetings.deleteAttendee(request).promise();
}

/*
 * Helper function to generate an IAM policy.
 *
 * This is used by the lambda token authorizer to authorize the user.
 */
function generatePolicy(principalId: any, effect: any) {
    let authResponse: any = {};

    authResponse.principalId = principalId
    if (effect) {
        var policyDocument: any = {};
        policyDocument.Version = '2012-10-17';
        policyDocument.Statement = [];

        var statementOne: any = {};
        statementOne.Action = 'execute-api:Invoke';
        statementOne.Effect = effect;
        statementOne.Resource = '*';

        policyDocument.Statement[0] = statementOne;
        authResponse.policyDocument = policyDocument;
    }

    console.log('Generated policy: ' + JSON.stringify(authResponse));
    return authResponse;
}

function response(statusCode: any, contentType: any, body: any, isBase64Encoded = false) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': contentType,
        },
        body: body,
        isBase64Encoded
    };
}
