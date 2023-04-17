//
//  handlers.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2023-04-17.
//
//

const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

// Store meetings in a DynamoDB so attendees can join by meeting title
const ddb = new AWS.DynamoDB();

// Read environment.
const currentRegion = process.env.REGION;
const meetingsTableName = process.env.MEETINGS_TABLE_NAME;

const chimeSDKMeetings = new AWS.ChimeSDKMeetings({region: currentRegion});


/*
 * Handlers
 */

exports.index = async (event, context, callback) => {
    return response(200, 'text/plain', 'Success');
}

exports.join = async (event, context) => {
    const meetingIdFormat = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;
    const query = event.queryStringParameters;
    if (!query.title || !query.name) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameters: title, name' }));
    }

    // Look up the meeting by its title
    let meeting = await getMeeting(query.title);

    // If no meeting, create one
    if (!meeting) {
        if (!query.region) {
            return response(
                400,
                'application/json',
                JSON.stringify({ error: 'Need region parameter set if meeting has not yet been created' })
            );
        }

        let request = {
            // Use a UUID for the client request token to ensure that any request retries do not create multiple
            // meetings.
            ClientRequestToken: uuidv4(),

            // Specify the media region (where the meeting is hosted). In this case, we use the region selected by the
            // user.
            MediaRegion: query.region,

            // Our external ID for the meeting. For simplicity, this is just the meeting title right now.
            ExternalMeetingId: query.title.substring(0, 64)
        };

        console.info('Creating new meeting: ' + JSON.stringify(request));
        meeting = await chimeSDKMeetings.createMeeting(request).promise();

        // Store the meeting in the table using the meeting title as the key.
        await putMeeting(query.title, meeting);
    }

    // Create new attendee for the meeting
    console.info('Adding new attendee');
    const attendee = (await chimeSDKMeetings.createAttendee({
        // The meeting ID of the created meeting to add the attendee to
        MeetingId: meeting.Meeting.MeetingId,

        // Our external ID for the user. For simplicity, this is just for random hex bytes, followed by the username
        // for now.
        ExternalUserId: `${uuidv4().substring(0, 8)}#${query.name}`.substring(0, 64)
    }).promise());

    // Return the meeting and attendee responses. The client will use these to join the meeting.
    let joinResponse = {
        JoinInfo: {
            Meeting: meeting,
            Attendee: attendee
        }
    }
    return response(200, 'application/json', JSON.stringify(joinResponse, null, 2));
};

exports.end = async (event, context) => {
    // Fetch the meeting by title
    const meeting = await getMeeting(event.queryStringParameters.title);

    // End the meeting. All attendee connections will hang up.
    await chimeSDKMeetings.deleteMeeting({ MeetingId: meeting.Meeting.MeetingId }).promise();
    return response(200, 'application/json', JSON.stringify({}));
}

exports.deleteAttendee = async (event, context) => {
    // Fetch the meeting by title
    const meeting = await getMeeting(event.queryStringParameters.title);

    // Delete the attendee.  We currently don't store users, so the client needs to provide the Chime attendee ID
    // directly (since we have no easy way of finding an attendee from the external user ID).
    await chimeSDKMeetings.deleteAttendee({
        MeetingId: meeting.Meeting.MeetingId,
        AttendeeId: event.queryStringParameters.attendeeId
    }).promise();
    return response(200, 'application/json', JSON.stringify({}));
}

/*
 * Helpers
 */

/*
 * Retrieve a meeting from the meeting table using its title.
 */
async function getMeeting(title) {
    const result = await ddb.getItem({
        TableName: meetingsTableName,
        Key: {
            'Title': { S: title }
        }
    }).promise();
    return result.Item ? JSON.parse(result.Item.Data.S) : null;
}

/*
 * Store a meeting in the meeting table under its key.
 */
async function putMeeting(title, meeting) {
    await ddb.putItem({
        TableName: meetingsTableName,
        Item: {
            Title: { S: title },
            Data: { S: JSON.stringify(meeting) },

            // Set time-to-live to one day, causing the meeting record to be cleaned up automatically after 24 hours.
            TTL: { N: `${Math.floor(Date.now() / 1000) + 60 * 60 * 24}`}
        }
    }).promise();
}

function response(statusCode, contentType, body, isBase64Encoded = false) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': contentType,
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'
        },
        body: body,
        isBase64Encoded
    };
}
