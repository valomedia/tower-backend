#!/usr/bin/env node
//
//  clean.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

// Makes the script crash on unhandled rejections instead of silently ignoring them. In the future, promise rejections
// that are not handled will terminate the Node.js process with a non-zero exit code.
process.on('unhandledRejection', err => {
    throw err
});

const fs = require('fs-extra');

const paths = require('../config/paths');

fs.emptyDirSync(paths.build);
