#!/usr/bin/env node
//
//  test.js
//  tower-backend
//

// Makes the script crash on unhandled rejections instead of silently ignoring them. In the future, promise rejections
// that are not handled will terminate the Node.js process with a non-zero exit code.
process.on('unhandledRejection', err => {
    throw err
});

const paths = require('../config/paths');
const { spawnOrFail } = require('./lib');

spawnOrFail('npm', ['ci', '--include=dev'], {cwd: paths.src}, false);
spawnOrFail('npm', ['test'], {cwd: paths.src});
