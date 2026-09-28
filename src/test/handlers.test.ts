/*
 * Copyright (c) 2023-2026 valo.media GmbH
 * All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

//
//  handlers.test.ts
//  tower-backend
//

import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {
    DeleteItemCommand,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
    UpdateItemCommand
} from '@aws-sdk/client-dynamodb';
import {isUUID} from '../helpers';

process.env.AWS_REGION = 'eu-central-1';
process.env.ASSISTANCE_REQUESTS_TABLE_NAME = 'AssistanceRequests';
process.env.CALL_RECORDS_TABLE_NAME = 'CallRecords';
process.env.COMMUNICATION_USER_IDS_TABLE_NAME = 'CommunicationUserIds';
process.env.USER_PROFILES_TABLE_NAME = 'UserProfiles';
process.env.AUTH_URL = 'https://auth.example.test';
process.env.COMMUNICATION_SERVICES_ENDPOINT = 'https://example.communication.azure.com';
process.env.COMMUNICATION_SERVICES_ACCESSKEY = 'unused-test-key';
process.env.EXTRA_HOURS = '';
process.env.HOLIDAYS = '';
process.env.HOURS_DESCRIPTION = '';
process.env.UPLOAD_BUCKET = 'UploadBucket';

const callHandler = async (handler: any, body: unknown, principalId = 'assistant.alice') => handler({
    body: JSON.stringify(body),
    requestContext: {
        authorizer: {principalId}
    }
}, {}, () => {});

test('beginAssistanceHandler returns a meeting id and stores billable call timestamps', async () => {
    const {beginAssistanceHandler} = await import('../handlers.js');
    const startDateTime = '2026-06-12T12:00:00.000Z';
    const futureTtl = Math.floor(Date.now() / 1000) + 60;
    const commands: any[] = [];

    const send = mock.method(DynamoDBClient.prototype, 'send', async (command: any) => {
        commands.push(command);
        if (command instanceof QueryCommand) {
            return {
                Items: [{
                    Username: {S: 'user_550e8400-e29b-41d4-a716-446655440000'},
                    DateTime: {S: startDateTime},
                    TTL: {N: `${futureTtl}`}
                }]
            };
        }
        if (command instanceof DeleteItemCommand) {
            return {
                Attributes: {
                    Username: {S: 'user_550e8400-e29b-41d4-a716-446655440000'},
                    DateTime: {S: startDateTime},
                    TTL: {N: `${futureTtl}`}
                }
            };
        }
        if (command instanceof GetItemCommand && command.input.TableName === 'UserProfiles') {
            return {
                Item: {
                    Username: {S: 'user_550e8400-e29b-41d4-a716-446655440000'},
                    FirstName: {S: 'Ada'}
                }
            };
        }
        if (command instanceof GetItemCommand && command.input.TableName === 'CommunicationUserIds') {
            return {
                Item: {
                    Username: {S: 'user_550e8400-e29b-41d4-a716-446655440000'},
                    CommunicationUserId: {S: 'acs-user'}
                }
            };
        }
        if (command instanceof PutItemCommand) {
            return {};
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    try {
        const result = await callHandler(beginAssistanceHandler, {});
        const body = JSON.parse(result.body);
        const putCommand = commands.find(command => command instanceof PutItemCommand) as PutItemCommand | undefined;
        assert.ok(putCommand);
        const putItem = putCommand.input.Item;
        assert.ok(putItem);

        assert.equal(result.statusCode, 200);
        assert.equal(isUUID(body.meeting), true);
        assert.equal(body.assistanceRequest.startDateTime, startDateTime);
        assert.equal(body.assistanceRequest.user.communicationUserId, 'acs-user');
        assert.equal(putCommand.input.TableName, 'CallRecords');
        assert.equal(putItem.Meeting.S, body.meeting);
        assert.equal(putItem.Caller.S, 'user_550e8400-e29b-41d4-a716-446655440000');
        assert.equal(putItem.Assistant.S, 'assistant.alice');
        assert.equal(putItem.StartDateTime.S, startDateTime);
        assert.match(putItem.AcceptDateTime.S || '', /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(putItem.Billable.BOOL, true);
    } finally {
        send.mock.restore();
    }
});

test('endAssistanceHandler records end timestamp and non-billable flag for the assistant meeting', async () => {
    const {endAssistanceHandler} = await import('../handlers.js');
    const meeting = '3ef07231-bc85-4e66-a331-6a017e289723';
    let updateCommand: UpdateItemCommand | undefined;

    const send = mock.method(DynamoDBClient.prototype, 'send', async (command: any) => {
        assert.equal(command instanceof UpdateItemCommand, true);
        updateCommand = command;
        return {};
    });

    try {
        const result = await callHandler(endAssistanceHandler, {meeting, nonBillable: true});

        assert.equal(result.statusCode, 200);
        assert.equal(result.body, '{}');
        assert.equal(updateCommand?.input.TableName, 'CallRecords');
        assert.equal(updateCommand?.input.Key?.Meeting?.S, meeting);
        assert.equal(updateCommand?.input.UpdateExpression, 'SET EndDateTime = :endDateTime, Billable = :billable');
        assert.equal(
            updateCommand?.input.ConditionExpression,
            'attribute_exists(Meeting) AND Assistant = :assistant AND attribute_not_exists(EndDateTime)'
        );
        assert.match(updateCommand?.input.ExpressionAttributeValues?.[':endDateTime']?.S || '', /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(updateCommand?.input.ExpressionAttributeValues?.[':billable']?.BOOL, false);
        assert.equal(updateCommand?.input.ExpressionAttributeValues?.[':assistant']?.S, 'assistant.alice');
    } finally {
        send.mock.restore();
    }
});

test('endAssistanceHandler defaults to billable calls', async () => {
    const {endAssistanceHandler} = await import('../handlers.js');
    const meeting = '3ef07231-bc85-4e66-a331-6a017e289723';
    let updateCommand: UpdateItemCommand | undefined;

    const send = mock.method(DynamoDBClient.prototype, 'send', async (command: any) => {
        updateCommand = command;
        return {};
    });

    try {
        const result = await callHandler(endAssistanceHandler, {meeting});

        assert.equal(result.statusCode, 200);
        assert.equal(updateCommand?.input.ExpressionAttributeValues?.[':billable']?.BOOL, true);
    } finally {
        send.mock.restore();
    }
});

test('endAssistanceHandler validates request body before writing', async () => {
    const {endAssistanceHandler} = await import('../handlers.js');
    const send = mock.method(DynamoDBClient.prototype, 'send', async () => {
        throw new Error('DynamoDB should not be called for invalid requests');
    });

    try {
        const missingMeeting = await callHandler(endAssistanceHandler, {nonBillable: false});
        const invalidNonBillable = await callHandler(endAssistanceHandler, {
            meeting: '3ef07231-bc85-4e66-a331-6a017e289723',
            nonBillable: 'yes'
        });

        assert.equal(missingMeeting.statusCode, 400);
        assert.deepEqual(JSON.parse(missingMeeting.body), {error: 'Need parameter: meeting'});
        assert.equal(invalidNonBillable.statusCode, 400);
        assert.deepEqual(JSON.parse(invalidNonBillable.body), {error: 'Parameter nonBillable must be a boolean'});
        assert.equal(send.mock.callCount(), 0);
    } finally {
        send.mock.restore();
    }
});

test('endAssistanceHandler returns 404 for missing, already ended, or different-assistant meetings', async () => {
    const {endAssistanceHandler} = await import('../handlers.js');
    const send = mock.method(DynamoDBClient.prototype, 'send', async () => {
        const err = new Error('condition failed');
        err.name = 'ConditionalCheckFailedException';
        throw err;
    });

    try {
        const result = await callHandler(endAssistanceHandler, {meeting: '3ef07231-bc85-4e66-a331-6a017e289723'});

        assert.equal(result.statusCode, 404);
        assert.deepEqual(JSON.parse(result.body), {message: 'Open meeting not found'});
    } finally {
        send.mock.restore();
    }
});
