//
//  lib.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

const { spawnSync } = require('child_process');

function spawnOrFail(command, args, options = null, printOutput = true) {
    const cmd = spawnSync(command, args, options || {});
    if (cmd.error) {
        // noinspection JSUnresolvedReference
        console.log(`Command ${command} failed with ${cmd.error.code}`);
        process.exit(255);
    }
    const output = cmd.stdout.toString();
    if (printOutput) {
        console.log(output);
    }
    if (cmd.status !== 0) {
        console.log(`Command ${command} failed with exit code ${cmd.status} signal ${cmd.signal}`);
        console.log(cmd.stderr.toString());
        process.exit(cmd.status);
    }
    return output;
}

module.exports = {
    spawnOrFail
};
