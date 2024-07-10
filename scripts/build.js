#!/usr/bin/env node
//
//  build.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

const fs = require('fs-extra');
const path = require('path');

const paths = require('../config/paths');
const { spawnOrFail } = require('./lib');

fs.copyFileSync(paths.lambdaPackageJson, path.resolve(paths.build, 'package.json'));
fs.copyFileSync(paths.lambdaPackageLockJson, path.resolve(paths.build, 'package-lock.json'));
spawnOrFail(
    'npm',
    ['install'],
    {
        cwd: paths.src,
        env: {...process.env, NODE_ENV: 'development'}
    },
    false);
spawnOrFail(
    'npm',
    ['install'],
    {
        cwd: paths.build,
        env: {...process.env, NODE_ENV: 'production'}
    },
    false);
spawnOrFail('npx', ['tsc']);
