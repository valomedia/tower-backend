/*
 * Copyright (c) 2026 valo.media GmbH
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

import test, {afterEach, beforeEach, mock, TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {Socket} from 'node:net';
import {resolve} from 'node:path';
import {createLocalServer, LOCAL_ROUTES} from '../local/server';
import {MemoryImages} from '../local/images';
import {MemoryDatabase} from '../local/database';
import {GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand} from '@aws-sdk/client-dynamodb';

beforeEach(() => {
    // Catch accidental SDK/auth/email/credential-discovery traffic as well as direct outbound HTTP.
    const connect = Socket.prototype.connect;
    mock.method(Socket.prototype, 'connect', function (this: Socket, ...args: any[]) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        const host = typeof options === 'object' ? options.host : args[1];
        assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), `Unexpected outbound connection: ${host}`);
        return connect.apply(this, args as Parameters<typeof connect>);
    });
});

afterEach(() => mock.restoreAll());

function basic(username = 'any.assistant', password = 'any:password'): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function start(t: TestContext, options: Parameters<typeof createLocalServer>[0] = {}) {
    const server = createLocalServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    async function close(): Promise<void> {
        if (!server.listening) {return;}
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    t.after(close);
    async function api(path: string, body?: unknown, authorization?: string, method?: string) {
        const res = await fetch(url + path, {
            method: method || (body === undefined ? 'GET' : 'POST'),
            headers: {
                'Content-Type': 'application/json',
                ...(authorization === undefined ? {} : {Authorization: authorization})
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return {status: res.status, headers: res.headers, body: await res.json() as any};
    }
    return {url, api, close};
}

test('local routes match SAM methods, handler names and authorization', () => {
    const template = readFileSync(resolve(__dirname, '../../template.yaml'), 'utf8');
    const routes = template.split(/\n(?= {2}\w+:\n)/).flatMap(resource => {
        const handler = /Handler: handlers\.(\w+)/.exec(resource)?.[1];
        const path = /Path: (\S+)/.exec(resource)?.[1];
        const method = /Method: (\S+)/.exec(resource)?.[1];
        return handler && path && method
            ? [{method, path, handler, authenticated: !resource.includes('Authorizer: NONE')}] : [];
    });
    assert.equal(routes.length, 13);
    assert.deepEqual(LOCAL_ROUTES, routes);
});

test('local HTTP authentication accepts arbitrary credentials without assistant accounts', async t => {
    const {api} = await start(t);
    for (const route of LOCAL_ROUTES.filter(route => route.authenticated)) {
        const result = await api(route.path, undefined, undefined, route.method);
        assert.equal(result.status, 401, route.path);
        assert.match(result.headers.get('www-authenticate') || '', /^Basic /);
    }
    for (const header of ['Bearer token', 'Basic !!!!', 'Basic bm9jb2xvbg==', 'Basic YTo===']) {
        assert.equal((await api('/assistanceToken', undefined, header)).status, 401);
    }
    for (const [username, password] of [['alice', 'one'], ['bob', 'two:three'], ['ä-user', ''], ['', ''], ['__proto__', 'any']]) {
        const result = await api('/assistanceToken', undefined, basic(username, password));
        assert.equal(result.status, 200);
        assert.equal(result.body.userToken.user.username, username);
        assert.ok(Date.parse(result.body.userToken.expiresOn) > Date.now());
        assert.match(result.body.userToken.token, /\.local-only$/);
        const again = await api('/assistanceToken', undefined, basic(username, 'another password'));
        assert.equal(again.body.userToken.user.communicationUserId, result.body.userToken.user.communicationUserId);
    }
    const first = await api('/assistanceToken', undefined, basic('same', 'old'));
    const second = await api('/assistanceToken', undefined, basic('same', 'changed'));
    assert.equal(first.body.userToken.user.communicationUserId, second.body.userToken.user.communicationUserId);
    assert.equal((await api('/')).body.openingHours.status, 'open');
    assert.equal((await api('/missing')).status, 404);
    assert.equal((await api('/registerUser')).status, 404);
    assert.equal((await api('/registerUser', undefined, undefined, 'POST')).status, 200);
    for (const path of ['/getUser', '/updateUser', '/requestAssistance', '/awaitAssistance', '/cancelAssistance']) {
        assert.equal((await api(path, undefined, undefined, 'POST')).status, 400, path);
    }
});

test('profiles, queue, call ownership and image transfers work without any external service', async t => {
    // Even a shell configured for production cannot select cloud dependencies in the local entry point.
    const env = {
        AUTH_URL: 'https://auth.example.invalid', AWS_REGION: 'eu-central-1',
        COMMUNICATION_SERVICES_ENDPOINT: 'https://example.communication.azure.com',
        MAIL_FROM_ADDRESS: 'noreply@example.invalid', UPLOAD_BUCKET: 'not-a-local-bucket'
    };
    for (const [name, value] of Object.entries(env)) {
        const previous = process.env[name];
        process.env[name] = value;
        t.after(() => {if (previous === undefined) {delete process.env[name];} else {process.env[name] = previous;}});
    }
    const {api, url} = await start(t);
    const auth = basic();
    assert.deepEqual((await api('/offerAssistance', undefined, auth)).body, {});
    assert.equal((await api('/beginAssistance', {}, auth)).status, 404);
    const registration = await api('/registerUser', {firstName: 'Ada', email: 'ada@example.test'});
    assert.equal(registration.status, 200);
    const {userId} = registration.body;
    assert.equal((await api('/registerUser', {email: 'ada@example.test'})).status, 400);
    assert.equal((await api('/registerUser', {email: 'invalid'})).status, 400);
    assert.equal((await api('/getUser', {userId})).body.user.firstName, 'Ada');
    assert.equal((await api('/updateUser', {userId, firstName: 'Grace', email: 'grace@example.test'})).status, 200);
    assert.equal((await api('/getUser', {userId})).body.user.email, 'grace@example.test');

    const request = await api('/requestAssistance', {userId});
    assert.equal(request.status, 200);
    assert.equal(request.body.keepaliveInterval, 10);
    const queued = await api('/offerAssistance', undefined, auth);
    assert.equal(queued.body.assistanceRequest.user.username, `user_${userId}`);
    assert.equal((await api('/awaitAssistance', {userId})).body.position, 0);
    assert.equal((await api('/offerAssistance', undefined, auth)).body.assistanceRequest.startDateTime,
        queued.body.assistanceRequest.startDateTime);
    const competitors = await Promise.all([
        api('/beginAssistance', {}, auth), api('/beginAssistance', {}, auth)
    ]);
    assert.deepEqual(competitors.map(result => result.status).sort(), [200, 404]);
    const call = competitors.find(result => result.status === 200)!;
    const {meeting} = call.body;
    assert.equal(call.body.assistanceRequest.user.firstName, 'Grace');
    assert.equal((await api('/awaitAssistance', {userId})).status, 404);
    assert.equal((await api('/endAssistance', {meeting}, basic('someone-else'))).status, 404);
    assert.equal((await api('/endAssistance', {meeting, nonBillable: 'yes'}, auth)).status, 400);
    assert.equal((await api('/endAssistance', {meeting, nonBillable: true}, auth)).status, 200);
    assert.equal((await api('/endAssistance', {meeting}, auth)).status, 404);
    await api('/requestAssistance', {userId});
    assert.equal((await api('/cancelAssistance', {userId})).status, 200);
    assert.equal((await api('/cancelAssistance', {userId})).status, 404);

    const upload = await api('/createImageUploadUrl', {}, auth);
    assert.equal(upload.status, 200);
    assert.ok(upload.body.uploadUrl.startsWith(url + '/local-images/'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    assert.equal((await fetch(upload.body.uploadUrl, {method: 'PUT', body: jpeg})).status, 200);
    assert.equal((await fetch(upload.body.uploadUrl, {method: 'PUT', body: jpeg})).status, 403);
    const download = await api('/createImageDownloadUrl', {key: upload.body.key}, auth);
    assert.equal(download.status, 200);
    assert.ok(download.body.downloadUrl.startsWith(url + '/local-images/'));
    const image = await fetch(download.body.downloadUrl);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
    assert.equal((await api('/createImageDownloadUrl', {}, auth)).status, 400);
});

test('queue keeps FIFO ordering, replaces duplicate requests and expires stale entries', async t => {
    const {api} = await start(t);
    const auth = basic();
    const first = (await api('/registerUser', {})).body.userId;
    const second = (await api('/registerUser', {})).body.userId;
    const now = Date.now();
    t.mock.timers.enable({apis: ['Date'], now});
    await api('/requestAssistance', {userId: first});
    t.mock.timers.setTime(now + 1000);
    await api('/requestAssistance', {userId: second});
    assert.equal((await api('/awaitAssistance', {userId: second})).body.position, 1);
    assert.equal((await api('/offerAssistance', undefined, auth)).body.assistanceRequest.user.username, `user_${first}`);
    t.mock.timers.setTime(now + 2000);
    await api('/requestAssistance', {userId: first});
    assert.equal((await api('/awaitAssistance', {userId: first})).body.position, 1);
    t.mock.timers.setTime(now + 40_000);
    assert.deepEqual((await api('/offerAssistance', undefined, auth)).body, {});
    assert.equal((await api('/awaitAssistance', {userId: first})).status, 404);
});

test('restarting discards profiles, identities, queued requests, calls and images', async t => {
    const first = await start(t);
    const auth = basic();
    const {userId} = (await first.api('/registerUser', {email: 'same@example.test'})).body;
    const identity = (await first.api('/assistanceToken', undefined, auth)).body.userToken.user.communicationUserId;
    await first.api('/requestAssistance', {userId});
    const {meeting} = (await first.api('/beginAssistance', {}, auth)).body;
    await first.api('/requestAssistance', {userId});
    const upload = (await first.api('/createImageUploadUrl', {}, auth)).body;
    await fetch(upload.uploadUrl, {method: 'PUT', body: 'image'});
    const {downloadUrl} = (await first.api('/createImageDownloadUrl', {key: upload.key}, auth)).body;
    await first.close();
    const second = await start(t);
    assert.equal((await second.api('/getUser', {userId})).status, 404);
    assert.deepEqual((await second.api('/offerAssistance', undefined, auth)).body, {});
    assert.equal((await second.api('/endAssistance', {meeting}, auth)).status, 404);
    assert.equal((await second.api('/registerUser', {email: 'same@example.test'})).status, 200);
    assert.notEqual((await second.api('/assistanceToken', undefined, auth)).body.userToken.user.communicationUserId, identity);
    assert.equal((await fetch(second.url + new URL(downloadUrl).pathname)).status, 403);
});

test('CORS preflight is unauthenticated and untrusted browser origins and hosts are rejected', async t => {
    const {url} = await start(t);
    const preflight = await fetch(url + '/beginAssistance', {
        method: 'OPTIONS', headers: {Origin: 'http://localhost:3000'}
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    const unauthorized = await fetch(url + '/assistanceToken', {headers: {Origin: 'http://localhost:3000'}});
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const denied = await fetch(url + '/registerUser', {method: 'POST', headers: {Origin: 'https://untrusted.example'}});
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    // Use node:http because fetch manages Host itself.
    const {request} = await import('node:http');
    const status = await new Promise<number | undefined>((resolve, reject) => {
        request(url, {headers: {Host: 'untrusted.example'}}, res => {
            res.resume();
            resolve(res.statusCode);
        }).on('error', reject).end();
    });
    assert.equal(status, 403);
});

test('trusted internal proxy origins can differ from browser-facing image URLs', async t => {
    const {url} = await start(t, {
        proxyOrigin: 'http://tower-backend:3001', publicUrl: 'http://localhost:43001'
    });
    const {request} = await import('node:http');
    const result = await new Promise<{status?: number; body: string}>((resolve, reject) => {
        request(url + '/createImageUploadUrl', {
            method: 'POST',
            headers: {
                Host: 'tower-backend:3001', Origin: 'http://tower-backend:3001',
                Authorization: basic(), 'Content-Type': 'application/json'
            }
        }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {body += chunk;});
            res.on('end', () => resolve({status: res.statusCode, body}));
        }).on('error', reject).end('{}');
    });
    assert.equal(result.status, 200);
    assert.ok(JSON.parse(result.body).uploadUrl.startsWith('http://localhost:43001/local-images/'));
    assert.throws(() => createLocalServer({proxyOrigin: 'https://example.test/path'}), /without a path/);
});

test('HTTP adapter limits request sizes and returns handler errors without stopping the server', async t => {
    const {url, api} = await start(t);
    const large = await fetch(url + '/registerUser', {method: 'POST', body: 'x'.repeat(10 * 1024 * 1024 + 1)});
    assert.equal(large.status, 413);
    await large.arrayBuffer();
    const errorLog = t.mock.method(console, 'error', () => {});
    assert.equal((await api('/getUser', {userId: {invalid: 'type'}})).status, 500);
    assert.equal(errorLog.mock.callCount(), 1);
    assert.equal((await api('/')).status, 200);
});

test('local image links enforce method and expiry without depending on S3', async t => {
    const images = new MemoryImages(() => 'http://localhost:3001');
    t.mock.timers.enable({apis: ['Date'], now: 1_000_000});
    const path = new URL(await images.createUrl('PUT', 'one.jpeg', 1)).pathname;
    assert.equal(images.handle('GET', path, Buffer.alloc(0)).status, 403);
    t.mock.timers.tick(1001);
    assert.equal(images.handle('PUT', path, Buffer.from('image')).status, 403);
});

test('memory database copies records and rejects unsupported query/update shapes', async () => {
    const db = new MemoryDatabase();
    const item = {Username: {S: 'one'}, FirstName: {S: 'original'}};
    await db.send(new PutItemCommand({TableName: 'UserProfiles', Item: item}));
    item.FirstName.S = 'changed';
    const get = new GetItemCommand({TableName: 'UserProfiles', Key: {Username: {S: 'one'}}});
    const result = await db.send(get);
    assert.equal(result.Item?.FirstName.S, 'original');
    result.Item!.FirstName.S = 'also changed';
    assert.equal((await db.send(get)).Item?.FirstName.S, 'original');
    await assert.rejects(db.send(new QueryCommand({TableName: 'UserProfiles', IndexName: 'Unknown'})), /Unsupported local query/);
    await assert.rejects(db.send(new UpdateItemCommand({TableName: 'UserProfiles', Key: item})), /Unsupported local update/);
});

test('opt-in DinD config resolves its build paths and retains both editor integrations', () => {
    const root = resolve(__dirname, '../..');
    const directory = resolve(root, '.devcontainer/docker');
    const config = JSON.parse(readFileSync(resolve(directory, 'devcontainer.json'), 'utf8'));
    const standard = JSON.parse(readFileSync(resolve(root, '.devcontainer/devcontainer.json'), 'utf8'));
    assert.equal(config.name, '${containerWorkspaceFolderBasename}');
    assert.equal(resolve(directory, config.build.dockerfile), resolve(root, '.devcontainer/Dockerfile'));
    assert.equal(resolve(directory, config.build.context), root);
    assert.ok(config.features['ghcr.io/devcontainers/features/docker-in-docker:2']);
    assert.equal(standard.features['ghcr.io/devcontainers/features/docker-in-docker:2'], undefined);
    assert.deepEqual(config.forwardPorts, [3001]);
    assert.ok(config.customizations.vscode);
    assert.ok(config.customizations.jetbrains);
});
