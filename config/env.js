//
//  env.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

const fs = require('fs-extra');

const paths = require('./paths');

function env(config) {
    return [
        config && `${paths.secrets}.${config}`,
        paths.secrets,
        config && `${paths.dotenv}.${config}.local`,
        `${paths.dotenv}.local`,
        config && `${paths.dotenv}.${config}`,
        paths.dotenv,
    ]
        .filter(Boolean)
        .filter(fs.existsSync);
}

module.exports = env;
