#!/usr/bin/env node
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

// NODE_ENV should always be production.
process.env.NODE_ENV = 'production';

// Makes the script crash on unhandled rejections instead of silently ignoring them. In the future, promise rejections
// that are not handled will terminate the Node.js process with a non-zero exit code.
process.on('unhandledRejection', err => {
    throw err
});

const fs = require('fs-extra');
const path = require('path');

const paths = require('../config/paths');
const { spawnOrFail } = require('./lib');

fs.copyFileSync(paths.lambdaPackageJson, path.resolve(paths.build, 'package.json'));
fs.copyFileSync(paths.lambdaPackageLockJson, path.resolve(paths.build, 'package-lock.json'));
spawnOrFail('npm', ['ci', '--include=dev'], {cwd: paths.src}, false);
spawnOrFail('npm', ['ci', '--omit=dev'], {cwd: paths.build}, false);
spawnOrFail('npx', ['tsc', '-p', paths.tsConfig], {cwd: paths.src});
