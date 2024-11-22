//
//  env.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

const fs = require('fs-extra');

const paths = require('./paths');

// Make sure that including paths.js after env.js will read .env variables.
delete require.cache[require.resolve('./paths')];

const NODE_ENV = process.env.NODE_ENV
if (!NODE_ENV) {
    throw new Error('The NODE_ENV environment variable is required but was not specified.');
}

const dotenvFiles = [
    `${paths.dotenv}.${NODE_ENV}.local`,
    NODE_ENV !== 'test' && `${paths.dotenv}.local`,
    `${paths.dotenv}.${NODE_ENV}`,
    paths.dotenv,
    `${paths.secrets}.${NODE_ENV}`,
    NODE_ENV !== 'test' && paths.secrets,
].filter(Boolean);

dotenvFiles.forEach(dotenvFile => {
    if (fs.existsSync(dotenvFile)) {
        require('@dotenvx/dotenvx').config({
            path: dotenvFile
        });
    }
});
