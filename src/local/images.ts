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

interface ImageLink {
    method: 'GET' | 'PUT';
    key: string;
    expiresAt: number;
}

export class MemoryImages {
    private readonly images = new Map<string, Buffer>();
    private readonly links = new Map<string, ImageLink>();

    constructor(private readonly baseUrl: () => string) {}

    async createUrl(method: 'GET' | 'PUT', key: string, expiresIn: number): Promise<string> {
        for (const [path, link] of this.links) {
            if (link.expiresAt <= Date.now()) {this.links.delete(path);}
        }
        const path = `/local-images/${randomUUID()}`;
        this.links.set(path, {method, key, expiresAt: Date.now() + expiresIn * 1000});
        return this.baseUrl() + path;
    }

    handle(method: string, path: string, body: Buffer): {status: number; body?: Buffer} {
        const link = this.links.get(path);
        if (!link || link.method !== method || link.expiresAt <= Date.now()) {return {status: 403};}
        if (method === 'PUT') {
            this.images.set(link.key, body);
            this.links.delete(path);
            return {status: 200};
        }
        const image = this.images.get(link.key);
        return image ? {status: 200, body: image} : {status: 404};
    }
}
