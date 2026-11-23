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

import type {CommunicationIdentityClient} from '@azure/communication-identity';
import {randomUUID} from 'node:crypto';

type LocalConfig = {
    dynamodbEndpoint: 'http://dynamodb:8000';
    s3Endpoint: string;
};

export const getLocalConfig = (
    env: Readonly<Record<string, string | undefined>> = process.env
): LocalConfig | undefined => {
    if (env.TOWER_LOCAL !== 'true') {return undefined;}
    if (env.AWS_SAM_LOCAL !== 'true') {
        throw new Error('TOWER_LOCAL=true requires AWS_SAM_LOCAL=true');
    }
    if (env.TOWER_LOCAL_DYNAMODB_ENDPOINT !== 'http://dynamodb:8000') {
        throw new Error('TOWER_LOCAL_DYNAMODB_ENDPOINT must be http://dynamodb:8000');
    }

    const s3Endpoint = env.TOWER_LOCAL_S3_ENDPOINT;
    // Validate the raw URL so URL normalization cannot hide paths or alternate host spellings.
    const match = s3Endpoint?.match(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?$/);
    if (!match || match[0] !== s3Endpoint || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
        throw new Error('TOWER_LOCAL_S3_ENDPOINT must be an HTTP loopback origin without credentials, path, query or fragment');
    }

    return {dynamodbEndpoint: env.TOWER_LOCAL_DYNAMODB_ENDPOINT, s3Endpoint};
};

export const createLocalIdentityClient = (): Pick<CommunicationIdentityClient, 'createUser' | 'getToken'> => ({
    async createUser() {
        return {communicationUserId: `8:acs:local-${randomUUID()}`};
    },
    async getToken(user, scopes, options) {
        const issuedAt = Math.floor(Date.now() / 1000);
        const expiresAt = issuedAt + (options?.tokenExpiresInMinutes ?? 1440) * 60;
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const header = encode({alg: 'RS256', typ: 'JWT', kid: 'tower-local-invalid'});
        const payload = encode({
            iss: 'tower-local',
            sub: user.communicationUserId,
            iat: issuedAt,
            nbf: issuedAt,
            exp: expiresAt,
            scp: scopes,
            towerLocal: true
        });
        // Deliberately not a cryptographic signature.
        // These tokens are only decodable fixtures and cannot authorize ACS calls.
        const signature = Buffer.from('LOCAL_ONLY_INVALID_SIGNATURE').toString('base64url');
        return {token: `${header}.${payload}.${signature}`, expiresOn: new Date(expiresAt * 1000)};
    }
});

export const getLocalPrincipalId = (token: unknown): string | undefined => {
    if (typeof token !== 'string') {return undefined;}
    const match = token.match(/^Basic +([A-Za-z0-9+/]+={0,2})$/i);
    if (!match || match[0] !== token) {return undefined;}

    const bytes = Buffer.from(match[1], 'base64');
    const canonical = bytes.toString('base64');
    if (match[1] !== canonical && match[1] !== canonical.replace(/=+$/, '')) {return undefined;}
    const credentials = bytes.toString('utf8');
    if (!Buffer.from(credentials, 'utf8').equals(bytes)
        || [...credentials].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        return undefined;
    }
    const separator = credentials.indexOf(':');
    if (separator < 0) {return undefined;}
    return credentials.slice(0, separator) || 'local-assistant';
};
