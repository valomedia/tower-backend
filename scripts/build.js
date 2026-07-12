#!/usr/bin/env node
//
//  build.js
//  tower-backend
//
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

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
