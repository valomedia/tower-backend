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
const {DynamoDBClient, ListTablesCommand} = require('../../src/node_modules/@aws-sdk/client-dynamodb');
const {S3Client, ListBucketsCommand} = require('../../src/node_modules/@aws-sdk/client-s3');
const {region, credentials} = require('../local-config');
const {waitUntilReady, bootstrapRequestHandler} = require('../local');

async function silentService(t) {
    const server = http.createServer(() => {});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.close();
        server.closeAllConnections();
    });
    return {server, endpoint: `http://127.0.0.1:${server.address().port}`};
}

for (const [name, Client, Command] of [
    ['DynamoDB Local', DynamoDBClient, ListTablesCommand],
    ['S3Mock', S3Client, ListBucketsCommand]
]) {
    test(`${name} bootstrap HTTP timeout rejects a connected but silent service`, {timeout: 5000}, async t => {
        const {endpoint} = await silentService(t);
        const client = new Client({region, credentials, endpoint, maxAttempts: 1,
            requestHandler: bootstrapRequestHandler});
        t.after(() => client.destroy());
        await assert.rejects(client.send(new Command({})), {name: 'TimeoutError', code: 'ETIMEDOUT'});
    });

    test(`${name} readiness deadline aborts an in-flight request and permits cleanup`, {timeout: 5000}, async t => {
        const {server, endpoint} = await silentService(t);
        let received = false;
        let disconnected;
        server.on('request', (_req, res) => {
            received = true;
            disconnected = once(res, 'close');
        });
        // Disable the per-request timeout to prove the overall deadline owns cancellation too.
        const client = new Client({region, credentials, endpoint, maxAttempts: 1, requestHandler: {requestTimeout: 0}});
        let cleanedUp = false;
        const waiting = async () => {
            try {
                await waitUntilReady(name, abortSignal => client.send(new Command({}), {abortSignal}),
                    new AbortController().signal, 500);
            } finally {
                client.destroy();
                cleanedUp = true;
            }
        };
        await assert.rejects(waiting(), new RegExp(`${name} did not become ready within 0.5 seconds`));
        assert.ok(received, 'the service must have accepted the request before the deadline');
        assert.ok(cleanedUp);
        await disconnected;
    });
}

test('readiness cancellation aborts a request already in flight', {timeout: 5000}, async t => {
    const {server, endpoint} = await silentService(t);
    const client = new DynamoDBClient({region, credentials, endpoint, maxAttempts: 1,
        requestHandler: {requestTimeout: 0}});
    t.after(() => client.destroy());
    const controller = new AbortController();
    const received = once(server, 'request');
    const waiting = waitUntilReady('test service', abortSignal => client.send(new ListTablesCommand({}), {abortSignal}),
        controller.signal);
    const [, response] = await received;
    const disconnected = once(response, 'close');
    controller.abort(new Error('cancelled during readiness'));
    await assert.rejects(waiting, /cancelled during readiness/);
    await disconnected;
});

test('readiness deadline reports the last transient failure', async () => {
    const failure = new Error('service unavailable');
    await assert.rejects(waitUntilReady('test service', async () => {throw failure;},
        new AbortController().signal, 20), error => {
        assert.match(error.message, /did not become ready/);
        assert.equal(error.cause, failure);
        return true;
    });
});
