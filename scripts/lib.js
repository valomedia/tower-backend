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
