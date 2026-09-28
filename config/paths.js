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

const path = require('path');
const fs = require('fs-extra');

/**
 * The directory the project is located in.
 */
const projectDirectory = fs.realpathSync(process.cwd());

/**
 * Resolve a path relative to the projectDirectory.
 */
const resolveRelativePath = relativePath => path.resolve(projectDirectory, relativePath);

/**
 * Absolute path of the main dotenv file.
 */
const dotenv = resolveRelativePath('.env');

/**
 * Absolute path of the main secrets file.
 */
const secrets = resolveRelativePath('.secrets');

/**
 * Absolute path of the project root.
 */
const project = resolveRelativePath('.');

/**
 * Absolute path of the directory the build output is written to.
 */
const build = resolveRelativePath(process.env.BUILD_PATH || 'build');

/**
 * Absolute path of the directory the typescript source code is contained in.
 */
const src = resolveRelativePath('src');

/**
 * Absolute path of the package.json for the lambda functions for the backend.
 */
const lambdaPackageJson = resolveRelativePath('src/package.json')

/**
 * Absolute path of the package-lock.json for the lambda functions for the backend.
 */
const lambdaPackageLockJson = resolveRelativePath('src/package-lock.json');

/**
 * Absolute path of the typescript configuration file.
 */
const tsConfig = resolveRelativePath('tsconfig.json');

if (!fs.existsSync(build)) {
    fs.mkdirSync(build);
}

module.exports = {
    dotenv,
    secrets,
    project,
    build,
    src,
    lambdaPackageJson,
    lambdaPackageLockJson,
    tsConfig
};
