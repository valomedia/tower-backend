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

import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {resolve} from 'node:path';
import {createHandlers} from '../application';
import {MemoryDatabase} from './database';
import {MemoryImages} from './images';

type HandlerName = keyof ReturnType<typeof createHandlers>;

// Keep method, path and authorization in sync with template.yaml.
export const LOCAL_ROUTES: ReadonlyArray<{
    method: string; path: string; handler: HandlerName; authenticated: boolean;
}> = [
    {method: 'GET', path: '/', handler: 'indexHandler', authenticated: false},
    {method: 'POST', path: '/registerUser', handler: 'registerUserHandler', authenticated: false},
    {method: 'POST', path: '/getUser', handler: 'getUserHandler', authenticated: false},
    {method: 'POST', path: '/updateUser', handler: 'updateUserHandler', authenticated: false},
    {method: 'POST', path: '/requestAssistance', handler: 'requestAssistanceHandler', authenticated: false},
    {method: 'POST', path: '/awaitAssistance', handler: 'awaitAssistanceHandler', authenticated: false},
    {method: 'POST', path: '/cancelAssistance', handler: 'cancelAssistanceHandler', authenticated: false},
    {method: 'GET', path: '/assistanceToken', handler: 'assistanceTokenHandler', authenticated: true},
    {method: 'GET', path: '/offerAssistance', handler: 'offerAssistanceHandler', authenticated: true},
    {method: 'POST', path: '/beginAssistance', handler: 'beginAssistanceHandler', authenticated: true},
    {method: 'POST', path: '/endAssistance', handler: 'endAssistanceHandler', authenticated: true},
    {method: 'POST', path: '/createImageUploadUrl', handler: 'createImageUploadUrlHandler', authenticated: true},
    {method: 'POST', path: '/createImageDownloadUrl', handler: 'createImageDownloadUrlHandler', authenticated: true}
];

interface LocalServerOptions {
    allowedOrigin?: string;
    publicUrl?: string;
    proxyOrigin?: string;
}

function normalizeOrigin(value: string): string {
    const origin = value.replace(/\/$/, '');
    if (!/^https?:\/\//.test(origin) || new URL(origin).origin !== origin) {
        throw new Error('Local origins must be HTTP(S) origins without a path');
    }
    return origin;
}

function basicUsername(authorization: string | undefined): string | undefined {
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization || '');
    if (!match) {return;}
    const decoded = Buffer.from(match[1], 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '')) {return;}
    const credentials = decoded.toString('utf8');
    const separator = credentials.indexOf(':');
    return separator < 0 ? undefined : credentials.slice(0, separator);
}

function json(res: ServerResponse, status: number, error: string): void {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({error}));
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) {
            json(res, 413, 'Request body exceeds 10 MiB');
            return;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/** Fresh state and explicit mocks on every instance; never imports the production entry point. */
export function createLocalServer(options: LocalServerOptions = {}): Server {
    const allowedOrigin = normalizeOrigin(options.allowedOrigin || 'http://localhost:3000');
    const publicUrl = options.publicUrl ? normalizeOrigin(options.publicUrl) : undefined;
    const proxyOrigin = options.proxyOrigin ? normalizeOrigin(options.proxyOrigin) : undefined;
    function baseUrl(): string {
        if (publicUrl) {return publicUrl;}
        const address = server.address();
        if (!address || typeof address === 'string') {throw new Error('Local server is not listening');}
        return `http://127.0.0.1:${address.port}`;
    }
    const images = new MemoryImages(baseUrl);
    const handlers = createHandlers({
        assistanceRequestsTableName: 'AssistanceRequests',
        callRecordsTableName: 'CallRecords',
        communicationUserIdsTableName: 'CommunicationUserIds',
        userProfilesTableName: 'UserProfiles',
        extraHours: [], holidays: [], hoursDescription: '',
        sourceUrl: 'https://github.com/valomedia/tower-backend',
        backendVersion: JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version
    }, {
        ddb: new MemoryDatabase(),
        communicationIdentityClient: {
            async createUser() {
                return {communicationUserId: `8:acs:00000000-0000-0000-0000-000000000000_${randomUUID()}`};
            },
            async getToken(user, scopes, tokenOptions) {
                const expiresOn = new Date(Date.now() + (tokenOptions?.tokenExpiresInMinutes || 120) * 60_000);
                const header = Buffer.from(JSON.stringify({alg: 'none', typ: 'JWT'})).toString('base64url');
                const payload = Buffer.from(JSON.stringify({
                    skypeid: user.communicationUserId,
                    scp: scopes.join(' '),
                    exp: Math.floor(expiresOn.getTime() / 1000),
                    iss: 'tower-local-mock'
                })).toString('base64url');
                return {token: `${header}.${payload}.local-only`, expiresOn};
            }
        },
        getImageUrl: (method, key, expiresIn) => images.createUrl(method, key, expiresIn),
        async sendEmailConfirmation() { /* No email is sent by the local server. */ }
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url || '/', baseUrl());
        const host = new URL(`http://${req.headers.host || ''}`).hostname;
        const trustedHosts = ['127.0.0.1', 'localhost', '[::1]', new URL(baseUrl()).hostname];
        if (proxyOrigin) {trustedHosts.push(new URL(proxyOrigin).hostname);}
        if (!trustedHosts.includes(host)) {
            json(res, 403, 'Unrecognized local host');
            return;
        }
        res.setHeader('Vary', 'Origin');
        if (req.headers.origin) {
            if (![allowedOrigin, baseUrl(), proxyOrigin].includes(req.headers.origin)) {
                json(res, 403, 'Origin not allowed');
                return;
            }
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type'
            });
            res.end();
            return;
        }
        const route = LOCAL_ROUTES.find(route => route.path === url.pathname && route.method === req.method);
        const isImage = url.pathname.startsWith('/local-images/');
        if (!route && !isImage) {
            json(res, 404, 'Route not found');
            return;
        }
        const username = basicUsername(req.headers.authorization);
        if (route?.authenticated && username === undefined) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Tower local development"');
            json(res, 401, 'Basic credentials required (any username and password are accepted locally)');
            return;
        }
        const body = await readBody(req, res);
        if (!body) {return;}
        if (isImage) {
            const image = images.handle(req.method || '', url.pathname, body);
            res.writeHead(image.status, {'Content-Type': 'image/jpeg'});
            res.end(image.body);
            return;
        }
        const result = await handlers[route!.handler]({
            body: body.toString('utf8'), requestContext: {authorizer: {principalId: username ?? ''}}
        });
        res.writeHead(result.statusCode, result.headers as Record<string, string>);
        res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
    }

    const server = createServer((req, res) => {
        void handle(req, res).catch(error => {
            console.error('Local request failed', error);
            if (!res.headersSent) {json(res, 500, 'Internal server error');}
            else {res.destroy();}
        });
    });
    server.requestTimeout = 30_000;
    return server;
}

if (require.main === module) {
    const port = Number(process.env.LOCAL_PORT || 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {throw new Error('Invalid LOCAL_PORT');}
    const host = process.env.LOCAL_HOST || '127.0.0.1';
    const server = createLocalServer({
        allowedOrigin: process.env.LOCAL_ORIGIN,
        publicUrl: process.env.LOCAL_PUBLIC_URL,
        proxyOrigin: process.env.LOCAL_PROXY_ORIGIN
    });
    server.on('error', error => {
        console.error(error);
        process.exitCode = 1;
    });
    server.listen(port, host, () => {
        console.warn('LOCAL DEVELOPMENT ONLY: any Basic credentials work; data is ephemeral; ACS and email are mocked.');
        console.info(`Tower backend listening at http://${host}:${port}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            server.close();
            server.closeAllConnections();
        });
    }
}
