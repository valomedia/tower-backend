#!/usr/bin/env node
//
//  clean.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2024-07-05.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

const fs = require('fs-extra');

const paths = require('../config/paths');

fs.emptyDirSync(paths.build);
