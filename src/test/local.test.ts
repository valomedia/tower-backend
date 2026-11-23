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

import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import {
    AttributeValue,
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand
} from '@aws-sdk/client-dynamodb';
import {S3Client} from '@aws-sdk/client-s3';
import {SESv2Client} from '@aws-sdk/client-sesv2';
import {CommunicationIdentityClient} from '@azure/communication-identity';
import {createLocalIdentityClient, getLocalConfig} from '../local';
import {isUUID, userIdToUsername} from '../helpers';

const localEnv = {
    TOWER_LOCAL: 'true',
    AWS_SAM_LOCAL: 'true',
    TOWER_LOCAL_DYNAMODB_ENDPOINT: 'http://dynamodb:8000',
    TOWER_LOCAL_S3_ENDPOINT: 'http://127.0.0.1:4569'
};

const decodeToken = (token: string) => {
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    assert.ok(parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)));
    assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), {
        alg: 'RS256', typ: 'JWT', kid: 'tower-local-invalid'
    });
    assert.equal(Buffer.from(parts[2], 'base64url').toString(), 'LOCAL_ONLY_INVALID_SIGNATURE');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
};

const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;
const callHandler = async (handler: any, body: unknown, principalId = 'any.operator') => handler({
    body: JSON.stringify(body),
    requestContext: {authorizer: {principalId}}
}, {}, () => {});

// Node runs this file in its own process, separate from production handler tests.
// Do not import handlers until the local environment and network guards are installed.
test('local configuration is disabled by default and ignores local endpoints without opt-in', () => {
    for (const env of [
        {},
        {AWS_SAM_LOCAL: 'true'},
        {...localEnv, TOWER_LOCAL: undefined},
        {...localEnv, TOWER_LOCAL: 'false'},
        {...localEnv, TOWER_LOCAL: 'TRUE'}
    ]) {
        assert.equal(getLocalConfig(env), undefined);
    }
});

test('local configuration requires both exact gates and does not mutate its supplied environment', () => {
    for (const sam of [undefined, '', 'false', 'TRUE']) {
        assert.throws(() => getLocalConfig({...localEnv, AWS_SAM_LOCAL: sam}), /AWS_SAM_LOCAL=true/);
    }
    const env = Object.freeze({...localEnv});
    assert.deepEqual(getLocalConfig(env), {
        dynamodbEndpoint: 'http://dynamodb:8000', s3Endpoint: 'http://127.0.0.1:4569'
    });
    assert.deepEqual(env, localEnv);
});

test('local DynamoDB configuration only accepts the launcher alias exactly', () => {
    for (const endpoint of [
        undefined, '', 'https://dynamodb:8000', 'http://dynamodb:8000/',
        'http://localhost:8000', 'http://127.0.0.1:8000', 'http://dynamodb:8001',
        'https://dynamodb.eu-central-1.amazonaws.com', 'http://dynamodb:8000?x=1',
        'http://user:password@dynamodb:8000', 'http://dynamodb:8000\n'
    ]) {
        assert.throws(() => getLocalConfig({...localEnv, TOWER_LOCAL_DYNAMODB_ENDPOINT: endpoint}), /DYNAMODB_ENDPOINT/);
    }
});

test('local S3 configuration only accepts pathless HTTP loopback origins', () => {
    for (const endpoint of [
        'http://127.0.0.1:4569', 'http://127.0.0.1', 'http://localhost',
        'http://localhost:4569', 'http://[::1]', 'http://[::1]:4569',
        'http://localhost:1', 'http://localhost:65535'
    ]) {
        assert.equal(getLocalConfig({...localEnv, TOWER_LOCAL_S3_ENDPOINT: endpoint})?.s3Endpoint, endpoint);
    }
    for (const endpoint of [
        undefined, '', 'https://127.0.0.1:4569', 'http://s3:4569', 'http://0.0.0.0:4569',
        'http://192.168.1.1:4569', 'http://169.254.169.254', 'https://s3.amazonaws.com',
        'http://localhost.example.com', 'http://127.0.0.1.example.com', 'http://[::]',
        'http://user:password@localhost:4569', 'http://@localhost:4569',
        'http://localhost:4569/', 'http://localhost:4569/bucket', 'http://localhost:4569/..',
        'http://localhost:4569?x=1', 'http://localhost:4569?', 'http://localhost:4569#fragment',
        'http://localhost:4569#', 'http://localhost:4569\\bucket',
        'http://localhost:', 'http://localhost:0', 'http://localhost:65536', 'http://localhost:-1',
        'http://localhost:1.5', 'http://localhost:4569\n', ' http://localhost:4569',
        'http://local\thost:4569', 'http://localhost.:4569', 'http://%6cocalhost:4569',
        'http://127.1:4569', 'http://2130706433:4569', 'http://0x7f000001:4569'
    ]) {
        assert.throws(() => getLocalConfig({...localEnv, TOWER_LOCAL_S3_ENDPOINT: endpoint}), /S3_ENDPOINT/);
    }
});

test('fake ACS identities are unique and tokens are explicitly invalid with the requested expiry', async t => {
    const now = Date.parse('2026-11-14T12:00:00.000Z');
    t.mock.method(Date, 'now', () => now);
    const client = createLocalIdentityClient();
    const users = await Promise.all(Array.from({length: 50}, () => createLocalIdentityClient().createUser()));
    assert.equal(new Set(users.map(user => user.communicationUserId)).size, users.length);
    assert.ok(users.every(user => user.communicationUserId.startsWith('8:acs:local-')));

    for (const minutes of [undefined, 120, 720, 7]) {
        const result = await client.getToken(users[0], ['voip.join'], minutes === undefined
            ? undefined : {tokenExpiresInMinutes: minutes});
        assert.ok(result.expiresOn instanceof Date);
        assert.equal(result.expiresOn.getTime(), now + (minutes ?? 1440) * 60_000);
        const claims = decodeToken(result.token);
        assert.equal(claims.iss, 'tower-local');
        assert.equal(claims.sub, users[0].communicationUserId);
        assert.equal(claims.iat, now / 1000);
        assert.equal(claims.nbf, claims.iat);
        assert.equal(claims.exp, result.expiresOn.getTime() / 1000);
        assert.equal(claims.towerLocal, true);
        assert.deepEqual(claims.scp, ['voip.join']);
    }
});

test('local handlers isolate cloud services while preserving DynamoDB-backed flows', async t => {
    Object.assign(process.env, localEnv, {
        AWS_REGION: 'eu-central-1',
        AWS_ACCESS_KEY_ID: 'ambient-credentials-must-not-be-used',
        AWS_SECRET_ACCESS_KEY: 'ambient-credentials-must-not-be-used',
        AWS_SESSION_TOKEN: 'ambient-session-must-not-be-used',
        ASSISTANCE_REQUESTS_TABLE_NAME: 'AssistanceRequests',
        CALL_RECORDS_TABLE_NAME: 'CallRecords',
        COMMUNICATION_USER_IDS_TABLE_NAME: 'CommunicationUserIds',
        USER_PROFILES_TABLE_NAME: 'UserProfiles',
        AUTH_URL: 'https://auth.example.test',
        MAIL_FROM_ADDRESS: 'sender@example.test',
        EXTRA_HOURS: '',
        HOLIDAYS: '',
        HOURS_DESCRIPTION: '',
        UPLOAD_BUCKET: 'local-uploads'
    });
    // Import must succeed without constructing the real ACS client or its credential.
    delete process.env.COMMUNICATION_SERVICES_ENDPOINT;
    delete process.env.COMMUNICATION_SERVICES_ACCESSKEY;
    const forbidCloudCall = () => {throw new Error('Local handlers must not contact cloud services');};
    const guards = [
        t.mock.method(https, 'request', forbidCloudCall),
        t.mock.method(http, 'request', forbidCloudCall),
        t.mock.method(SESv2Client.prototype, 'send', forbidCloudCall),
        t.mock.method(S3Client.prototype, 'send', forbidCloudCall),
        t.mock.method(CommunicationIdentityClient.prototype, 'createUser', forbidCloudCall),
        t.mock.method(CommunicationIdentityClient.prototype, 'getToken', forbidCloudCall)
    ];
    assert.deepEqual(getLocalConfig(), getLocalConfig(localEnv));
    const handlers = await import('../handlers.js');

    await t.test('auth accepts arbitrary Basic credentials and rejects malformed input without HTTPS', async () => {
        for (const [username, password] of [
            ['alice', 'anything'], ['another.user', 'arbitrary:password:with:colons'],
            ['Zoë', '密码:password'], ['alice', ''], ['', 'anything'], ['', '']
        ]) {
            const result = await handlers.authHandler({authorizationToken: basic(`${username}:${password}`)}, {} as any, () => {});
            assert.equal(result.principalId, username || 'local-assistant');
            assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
        }
        const unpadded = basic('bob:pass').replace(/=+$/, '').replace('Basic ', 'basic  ');
        assert.equal((await handlers.authHandler({authorizationToken: unpadded}, {} as any, () => {})).principalId, 'bob');
        for (const authorizationToken of [
            undefined, null, 42, '', 'Bearer anything', 'Basic', 'Basic ', 'Basic !!!',
            'Basic YQ==', 'Basic YTo===', 'Basic YTq=', basic('without-separator'),
            `${basic('alice:password')}\n`, `${basic('alice:password')} extra`,
            basic('alice:line\nbreak'), basic('alice:\0password'), 'Basic /zo='
        ]) {
            await assert.rejects(
                async () => handlers.authHandler({authorizationToken}, {} as any, () => {}),
                error => error === 'Unauthorized'
            );
        }
    });

    await t.test('registration, profile updates, requests and assistant tokens reuse stored local identities', async t => {
        const items = new Map<string, Record<string, AttributeValue>>();
        const commands: any[] = [];
        t.mock.method(DynamoDBClient.prototype, 'send', async function (this: DynamoDBClient, command: any) {
            assert.ok(this.config.endpoint);
            const endpoint = await this.config.endpoint();
            assert.equal(endpoint.protocol, 'http:');
            assert.equal(endpoint.hostname, 'dynamodb');
            assert.equal(endpoint.port, 8000);
            const credentials = await this.config.credentials();
            assert.equal(credentials.accessKeyId, 'local');
            assert.equal(credentials.secretAccessKey, 'local');
            assert.equal(credentials.sessionToken, undefined);
            commands.push(command);
            const input = command.input;
            if (command instanceof GetItemCommand) {
                return {Item: items.get(`${input.TableName}:${input.Key.Username.S}`)};
            }
            if (command instanceof PutItemCommand) {
                items.set(`${input.TableName}:${input.Item.Username.S}`, input.Item);
                return {};
            }
            if (command instanceof QueryCommand) {
                assert.equal(input.TableName, 'UserProfiles');
                assert.equal(input.IndexName, 'Email');
                return {Items: [...items.entries()]
                    .filter(([key, item]) => key.startsWith('UserProfiles:')
                        && item.Email?.S === input.ExpressionAttributeValues[':email'].S)
                    .map(([, item]) => item)};
            }
            throw new Error(`Unexpected command ${command.constructor.name}`);
        });
        const registration = await callHandler(handlers.registerUserHandler, {firstName: 'Ada', email: 'ada@example.test'});
        assert.equal(registration.statusCode, 200);
        const {userId} = JSON.parse(registration.body);
        assert.ok(isUUID(userId));
        const username = userIdToUsername(userId);
        const identity = items.get(`CommunicationUserIds:${username}`)?.CommunicationUserId.S;
        assert.match(identity || '', /^8:acs:local-/);
        assert.equal(items.get(`UserProfiles:${username}`)?.Email.S, 'ada@example.test');

        const updated = await callHandler(handlers.updateUserHandler, {userId, firstName: 'Ada', email: 'updated@example.test'});
        assert.equal(updated.statusCode, 200);
        assert.equal(items.get(`UserProfiles:${username}`)?.Email.S, 'updated@example.test');

        const checkToken = (userToken: any, minutes: number, scopes: string[]) => {
            const claims = decodeToken(userToken.token);
            assert.equal(claims.sub, userToken.user.communicationUserId);
            assert.deepEqual(claims.scp, scopes);
            assert.equal(claims.exp - claims.iat, minutes * 60);
            assert.equal(new Date(userToken.expiresOn).getTime(), claims.exp * 1000);
            assert.ok(claims.iat <= Date.now() / 1000 && claims.iat > Date.now() / 1000 - 10);
        };
        for (let i = 0; i < 2; i++) {
            const assistance = await callHandler(handlers.requestAssistanceHandler, {userId});
            assert.equal(assistance.statusCode, 200);
            const {userToken, keepaliveInterval} = JSON.parse(assistance.body);
            assert.equal(userToken.user.username, username);
            assert.equal(userToken.user.communicationUserId, identity);
            assert.equal(userToken.user.firstName, 'Ada');
            assert.equal(keepaliveInterval, 10);
            checkToken(userToken, 120, ['voip.join']);
        }
        const queued = items.get(`AssistanceRequests:${username}`);
        assert.equal(queued?.PartitionKey.S, '1');
        assert.match(queued?.DateTime.S || '', /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(Number(queued?.TTL.N) > Date.now() / 1000);

        const auth = await handlers.authHandler({authorizationToken: basic('new.operator:any:password')}, {} as any, () => {});
        let assistantIdentity: string | undefined;
        for (let i = 0; i < 2; i++) {
            const result = await callHandler(handlers.assistanceTokenHandler, {}, auth.principalId);
            assert.equal(result.statusCode, 200);
            const {userToken} = JSON.parse(result.body);
            assert.equal(userToken.user.username, 'new.operator');
            checkToken(userToken, 720, ['voip']);
            if (assistantIdentity) {assert.equal(userToken.user.communicationUserId, assistantIdentity);}
            assistantIdentity = userToken.user.communicationUserId;
        }
        assert.notEqual(assistantIdentity, identity);
        const identityWrites = commands.filter(command => command instanceof PutItemCommand
            && command.input.TableName === 'CommunicationUserIds');
        assert.equal(identityWrites.length, 2);
        assert.equal(items.get('CommunicationUserIds:new.operator')?.CommunicationUserId.S, assistantIdentity);

        const unregistered = await callHandler(handlers.requestAssistanceHandler, {userId: '550e8400-e29b-41d4-a716-446655440000'});
        assert.equal(unregistered.statusCode, 200);
        const {userToken} = JSON.parse(unregistered.body);
        assert.notEqual(userToken.user.communicationUserId, identity);
        assert.ok(items.has(`CommunicationUserIds:${userToken.user.username}`));
        assert.ok(items.has(`AssistanceRequests:${userToken.user.username}`));
        checkToken(userToken, 120, ['voip.join']);
    });

    await t.test('image URLs are presigned for public S3Mock using explicit dummy credentials without S3 traffic', async () => {
        const upload = await callHandler(handlers.createImageUploadUrlHandler, {});
        const {uploadUrl, key} = JSON.parse(upload.body);
        const download = await callHandler(handlers.createImageDownloadUrlHandler, {key});
        const {downloadUrl} = JSON.parse(download.body);
        for (const [result, signedUrl, expires] of [[upload, uploadUrl, 300], [download, downloadUrl, 7200]]) {
            assert.equal(result.statusCode, 200);
            const url = new URL(signedUrl);
            assert.equal(url.origin, 'http://127.0.0.1:4569');
            assert.equal(url.pathname, `/local-uploads/${key}`);
            assert.match(url.searchParams.get('X-Amz-Credential') || '', /^local\//);
            assert.equal(url.searchParams.get('X-Amz-Security-Token'), null);
            assert.equal(url.searchParams.get('X-Amz-Expires'), `${expires}`);
            assert.ok(url.searchParams.get('X-Amz-Signature'));
        }
    });

    for (const guard of guards) {assert.equal(guard.mock.callCount(), 0);}
});
