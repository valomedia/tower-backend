//
//  paths.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-03.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

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
