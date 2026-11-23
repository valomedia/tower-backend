/*
 * Copyright (c) 2026 valo.media GmbH
 * All rights reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const http = require('node:http');

function endToEndHeaders(headers) {
    const excluded = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade',
        ...(headers.connection || '').toLowerCase().split(',').map(name => name.trim())]);
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

async function startLocalProxy({port, samPort, origin}) {
    const agent = new http.Agent();
    const corsHeaders = {'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true'};
    const server = http.createServer((request, response) => {
        let receivedResponse = false;
        const upstream = http.request({hostname: '127.0.0.1', port: samPort, agent,
            method: request.method, path: request.url, headers: endToEndHeaders(request.headers)}, incoming => {
            receivedResponse = true;
            const headers = {...endToEndHeaders(incoming.headers), ...corsHeaders};
            // SAM local ignores GatewayResponses and skips CORS on early authorizer failures.
            // Restore the browser challenge without bypassing SAM's routes or authorization.
            if (incoming.statusCode === 401) {headers['www-authenticate'] ??= 'Basic';}
            response.writeHead(incoming.statusCode, headers);
            incoming.on('error', error => response.destroy(error));
            incoming.pipe(response);
        });
        upstream.on('error', () => {
            request.unpipe(upstream);
            request.resume();
            // An early 401 can finish before SAM consumes the upload.
            // An upload-side EPIPE must not replace that response.
            if (!receivedResponse && !response.destroyed) {
                response.writeHead(502, {...corsHeaders, 'content-type': 'application/json'});
                response.end(JSON.stringify({message: 'Cannot reach SAM local API'}));
            }
        });
        request.on('error', () => upstream.destroy());
        response.on('close', () => upstream.destroy());
        request.pipe(upstream);
    });
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
    } catch (error) {
        agent.destroy();
        throw error;
    }
    return {
        server,
        async close() {
            const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            server.closeAllConnections();
            agent.destroy();
            await closed;
        }
    };
}

module.exports = {startLocalProxy};
