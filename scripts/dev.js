#!/usr/bin/env node
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

const {spawn} = require('node:child_process');
const path = require('node:path');
const {spawnOrFail} = require('./lib');

const project = path.resolve(__dirname, '..');
const src = path.join(project, 'src');
spawnOrFail('npm', ['ci', '--include=dev'], {cwd: src}, false);
spawnOrFail('npx', ['tsc', '-p', 'tsconfig.local.json'], {cwd: src});

// Deliberately do not load deployment env or secret files.
const child = spawn(process.execPath, [path.join(project, 'build-local/local/server.js')], {
    cwd: project,
    stdio: 'inherit',
    env: {...process.env, NODE_PATH: path.join(src, 'node_modules')}
});
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
}
child.on('error', error => {
    console.error(error);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
});
