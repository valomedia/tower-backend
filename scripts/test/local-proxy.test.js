/*
 * Copyright (c) 2026 valo.media GmbH
 * All rights reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {startLocalProxy} = require('../local-proxy');

const origin = 'http://localhost:5173';

async function fixture(t, handler) {
    const sam = http.createServer(handler);
    sam.listen(0, '127.0.0.1');
    await once(sam, 'listening');
    t.after(() => {
        sam.close();
        sam.closeAllConnections();
    });
    const settings = {port: 0, samPort: sam.address().port, origin};
    const proxy = await startLocalProxy(settings);
    t.after(async () => {if (proxy.server.listening) {await proxy.close();}});
    return {sam, proxy, settings, port: proxy.server.address().port};
}

function request(port, options = {}, body) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({hostname: '127.0.0.1', port, agent: false, ...options}, incoming => {
            const chunks = [];
            incoming.on('data', chunk => chunks.push(chunk));
            incoming.on('error', reject);
            incoming.on('end', () => resolve({status: incoming.statusCode, headers: incoming.headers,
                body: Buffer.concat(chunks)}));
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}

function assertCors(headers) {
    assert.equal(headers['access-control-allow-origin'], origin);
    assert.equal(headers['access-control-allow-credentials'], 'true');
}

test('initial unauthenticated request receives a Basic challenge and credentialed CORS', {timeout: 5000}, async t => {
    const authorization = `Basic ${Buffer.from('alice:anything').toString('base64')}`;
    const seen = [];
    const {port} = await fixture(t, (req, res) => {
        seen.push(req.headers.authorization);
        if (!req.headers.authorization) {
            res.writeHead(401, {'content-type': 'application/json'});
            res.end('{"message":"Unauthorized"}');
        } else {
            res.end('{"user":"alice"}');
        }
    });
    const initial = await request(port, {path: '/assistanceToken', headers: {origin}});
    assert.equal(initial.status, 401);
    assert.equal(initial.headers['www-authenticate'], 'Basic');
    assert.equal(initial.body.toString(), '{"message":"Unauthorized"}');
    assertCors(initial.headers);
    const authenticated = await request(port, {path: '/assistanceToken', headers: {origin, authorization}});
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers['www-authenticate'], undefined);
    assert.equal(authenticated.body.toString(), '{"user":"alice"}');
    assertCors(authenticated.headers);
    assert.deepEqual(seen, [undefined, authorization]);
});

test('adapter preserves public, preflight, error and existing challenge responses', {timeout: 5000}, async t => {
    const {port} = await fixture(t, (req, res) => {
        const status = Number(req.url.slice(1));
        res.writeHead(status, {'content-type': 'application/json',
            'set-cookie': ['a=1', 'b=2'],
            'access-control-allow-methods': 'POST, GET',
            'access-control-allow-headers': 'Authorization,Content-Type',
            ...(status === 401 && {'www-authenticate': 'Basic realm="existing"'})});
        res.end(status === 204 ? undefined : '{"unchanged":true}');
    });
    for (const status of [200, 204, 401, 403, 500]) {
        const result = await request(port, {path: `/${status}`, method: status === 204 ? 'OPTIONS' : 'GET',
            headers: {origin: 'https://untrusted.invalid'}});
        assert.equal(result.status, status);
        assert.equal(result.body.toString(), status === 204 ? '' : '{"unchanged":true}');
        assert.deepEqual(result.headers['set-cookie'], ['a=1', 'b=2']);
        assert.equal(result.headers['access-control-allow-methods'], 'POST, GET');
        assert.equal(result.headers['access-control-allow-headers'], 'Authorization,Content-Type');
        assert.equal(result.headers['www-authenticate'], status === 401 ? 'Basic realm="existing"' : undefined);
        assertCors(result.headers);
    }
});

test('adapter forwards raw paths, queries, credentials and binary bodies without hop-by-hop headers', {timeout: 5000}, async t => {
    const body = Buffer.from([0, 255, 128, 1, 13, 10]);
    const {port} = await fixture(t, (req, res) => {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/test%2Fpath?a=1&a=%2B');
        assert.equal(req.headers.host, 'localhost:3001');
        assert.equal(req.headers.authorization, 'Basic YTo=');
        assert.equal(req.headers['x-hop-only'], undefined);
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            assert.deepEqual(Buffer.concat(chunks), body);
            res.writeHead(201, {'content-type': 'application/octet-stream', 'content-length': body.length,
                connection: 'close, x-hop-only', 'x-hop-only': 'removed'});
            res.end(body);
        });
    });
    const result = await request(port, {path: '/test%2Fpath?a=1&a=%2B', method: 'POST', headers: {
        host: 'localhost:3001', authorization: 'Basic YTo=', connection: 'close, x-hop-only',
        'x-hop-only': 'removed', 'content-length': body.length
    }}, body);
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, body);
    assert.equal(result.headers['content-length'], String(body.length));
    assert.equal(result.headers['x-hop-only'], undefined);
});

test('adapter streams requests and responses and preserves a challenge before an upload finishes', {timeout: 5000}, async t => {
    let finishResponse;
    const {port} = await fixture(t, (req, res) => {
        req.once('data', chunk => {
            assert.equal(chunk.toString(), 'first chunk');
            res.writeHead(401, {'content-type': 'text/plain'});
            res.write('challenge');
            finishResponse = () => res.end(' complete');
        });
    });
    const outgoing = http.request({hostname: '127.0.0.1', port, method: 'POST', agent: false});
    t.after(() => outgoing.destroy());
    outgoing.on('error', () => {}); // The upstream may close before the upload is complete.
    const responded = once(outgoing, 'response');
    outgoing.write('first chunk');
    const [incoming] = await responded;
    assert.equal(incoming.statusCode, 401);
    assert.equal(incoming.headers['www-authenticate'], 'Basic');
    assertCors(incoming.headers);
    const [chunk] = await once(incoming, 'data');
    assert.equal(chunk.toString(), 'challenge');
    const ended = once(incoming, 'end');
    finishResponse();
    incoming.resume();
    await ended;
});

test('unreachable SAM returns 502 with CORS, not an authentication challenge', {timeout: 5000}, async t => {
    const {port, sam} = await fixture(t, () => {});
    await new Promise(resolve => sam.close(resolve));
    const result = await request(port);
    assert.equal(result.status, 502);
    assert.equal(result.headers['www-authenticate'], undefined);
    assert.equal(JSON.parse(result.body).message, 'Cannot reach SAM local API');
    assertCors(result.headers);
});

test('truncated SAM responses terminate instead of appearing successful', {timeout: 5000}, async t => {
    const {port} = await fixture(t, (_req, res) => {
        res.writeHead(200, {'content-length': '100'});
        res.write('partial');
        setImmediate(() => res.destroy());
    });
    await assert.rejects(request(port), /aborted|socket hang up/);
});

test('client disconnect cancels the upstream request', {timeout: 5000}, async t => {
    let disconnected;
    const {port, sam} = await fixture(t, (_req, res) => {disconnected = once(res, 'close');});
    const reachedSAM = once(sam, 'request');
    const outgoing = http.get({hostname: '127.0.0.1', port, agent: false});
    outgoing.on('error', () => {});
    t.after(() => outgoing.destroy());
    await reachedSAM;
    outgoing.destroy();
    await disconnected;
});

test('shutdown closes active connections and a public port conflict fails explicitly', {timeout: 5000}, async t => {
    const {port, sam, proxy, settings} = await fixture(t, () => {});
    await assert.rejects(startLocalProxy({...settings, port}), {code: 'EADDRINUSE'});
    const reachedSAM = once(sam, 'request');
    const pending = assert.rejects(request(port), /socket hang up|aborted/);
    await reachedSAM;
    await proxy.close();
    await pending;
    assert.equal(proxy.server.listening, false);
});
