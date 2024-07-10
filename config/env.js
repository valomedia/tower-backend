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

const dotenvFiles = [
    paths.dotenv,
    `${paths.dotenv}.local`
]

dotenvFiles.forEach(dotenvFile => {
    if (fs.existsSync(dotenvFile)) {
        require('@dotenvx/dotenvx').config({
            path: dotenvFile
        });
    }
});
