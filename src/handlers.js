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

exports.index = async () => {
    return response(200, 'application/json', JSON.stringify({ message: 'Success' }));
}

exports.join = async (event) => {
    const query = event.queryStringParameters;
    if (!query.title || !query.name) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameters: title, name' }));
    }

    const region = query.region || currentRegion;

    // Look up the meeting by its title
    let meetingResponse = await getMeeting(query.title);

    // If no meeting, create one
    if (!meetingResponse) {
        console.info(`Creating new meeting ${query.title} in region ${region}`);
        meetingResponse = await createMeeting(query.title, region);
    }

    // Create new attendee for the meeting
    console.info('Adding new attendee');
    const attendeeResponse = await createAttendee(meetingResponse.Meeting, query.name);

    // Return the meeting and attendee responses. The client will use these to join the meeting.
    let joinResponse = {
        joinInfo: {
            meetingResponse,
            attendeeResponse
        }
    }
    return response(200, 'application/json', JSON.stringify(joinResponse, null, 2));
};

exports.end = async (event) => {
    const query = event.queryStringParameters;
    if (!query.title) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameter: title' }));
    }

    // Fetch the meeting by title
    const meeting = (await getMeeting(query.title)).Meeting;

    if (meeting) { await deleteMeeting(meeting); }
    return response(200, 'application/json', JSON.stringify({}));
}

exports.deleteAttendee = async (event) => {
    const query = event.queryStringParameters;
    if (!query.title || !query.attendeeId) {
        return response(400, 'application/json', JSON.stringify({ error: 'Need parameters: title, attendeeId' }));
    }

    // Fetch the meeting by title
    const meeting = (await getMeeting(query.title)).Meeting;

    await deleteAttendee(query.attendeeId, meeting);
    return response(200, 'application/json', JSON.stringify({}));
}

/*
 * Helpers
 */

/*
 * Retrieve a meeting ID from the meeting table using its title.
 *
 * This just looks up the meeting ID in the database. If the meeting has ended, the result might be a stale ID for a
 * meeting that no longer exists. The caller is expected to check whether the meeting actually exists before proceeding
 * to use the meeting ID for anything.
 */
async function getMeetingId(title) {
    const result = await ddb.getItem({
        TableName: meetingsTableName,
        Key: {
            'Title': { S: title }
        }
    }).promise();
    return result.Item ? result.Item.Data.S : null;
}

/*
 * Get a meeting by its title.
 *
 * This will return the meeting for the given title, if one exists.
 */
async function getMeeting(title) {
    const meetingId = await getMeetingId(title)
    if (!meetingId) { return null; }

    const request = { MeetingId: meetingId }
    console.debug('Getting meeting: ' + JSON.stringify(request));

    const meetingResponse = await chimeSDKMeetings.getMeeting(request).promise().catch(_ => ({}));
    console.debug('Got meeting: ' + JSON.stringify(meetingResponse));

    return meetingResponse
}

/*
 * Store a meetingID in the meeting table under its key.
 */
async function putMeetingId(title, meetingId) {
    await ddb.putItem({
        TableName: meetingsTableName,
        Item: {
            Title: { S: title },
            Data: { S: meetingId },

            // Set time-to-live to one day, causing the meeting record to be cleaned up automatically after 24 hours.
            TTL: { N: `${Math.floor(Date.now() / 1000) + 60 * 60 * 24}`}
        }
    }).promise();
}

/*
 * Store a meeting in the database.
 */
async function putMeeting(title, meeting) {
    await putMeetingId(title, meeting.MeetingId);
}

/*
 * Create a meeting and store it in the database.
 */
async function createMeeting(title, region){
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

    // Store the meeting in the table using the meeting title as the key.
    await putMeeting(title, meetingResponse.Meeting);

    return meetingResponse;
}

/*
 * Delete a given meeting.
 *
 * All attendee connections will hang up.
 */
async function deleteMeeting(meeting) {
    const request = { MeetingId: meeting.MeetingId };
    console.debug('Deleting meeting: ' + JSON.stringify(request));
    await chimeSDKMeetings.deleteMeeting(request).promise();
}

/*
 * Create an attendee with a given name for a given meeting.
 */
async function createAttendee(meeting, name) {
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
async function deleteAttendee(id, meeting) {
    const request = {
        MeetingId: meeting.MeetingId,
        AttendeeId: id
    }
    console.debug('Deleting attendee: ' + JSON.stringify(request));
    await chimeSDKMeetings.deleteAttendee(request).promise();
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
