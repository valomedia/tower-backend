#!/usr/bin/env node
//
//  deploy.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2023-04-17.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

// Makes the script crash on unhandled rejections instead of silently ignoring them. In the future, promise rejections
// that are not handled will terminate the Node.js process with a non-zero exit code.
process.on('unhandledRejection', err => {
    throw err
});

const { spawnSync } = require('child_process');

const { spawnOrFail } = require('./lib');

let
    region,
    bucket,
    stack,
    stage,
    authUrl,
    allowOrigin,
    communicationServicesEndpoint,
    communicationServicesAccesskey,
    hours,
    extraHours,
    holidays,
    hoursDescription,
    tz;

let disablePrintingLogs = false;
let env = 'development';

function usage() {
    console.log(`Usage: deploy.js [--env development|production] [-l] [-h]`);
    console.log(`Example: deploy.js --env development`);
    console.log(`Options:`);
    console.log(`  --env                        Env to deploy, 'development' or 'production', default '${env}'`);
    console.log(`  -l, --disable-printing-logs  Make the output less verbose`);
    console.log(`  -h, --help                   Show help and exit`);
}

function ensureBucket() {
    const s3Api = spawnSync('aws', ['s3api', 'head-bucket', '--bucket', bucket, '--region', region]);
    if (s3Api.status !== 0) {
        console.log(`Creating S3 bucket ${bucket}`);
        const s3 = spawnSync('aws', ['s3', 'mb', `s3://${bucket}`, '--region', region]);
        if (s3.status !== 0) {
            console.log(`Failed to create bucket: ${s3.status}`);
            console.log((s3.stderr || s3.stdout).toString());
            process.exit(s3.status);
        }
    }
}

function getArgOrExit(i, args) {
    if (i >= args.length) {
        console.log('Too few arguments');
        usage();
        process.exit(1);
    }
    return args[i];
}

function parseArgs() {
    let args = process.argv.slice(2);
    let i = 0;
    while (i < args.length) {
        switch(args[i]) {
            case '--env':
                 env = getArgOrExit(++i, args);
                 break;
            case '-h':
            case '--help':
                usage();
                process.exit(0);
                break;
            case '-l':
            case '--disable-printing-logs':
                disablePrintingLogs = true;
                break;
            default:
                console.log(`Invalid argument ${args[i]}`);
                usage();
                process.exit(1);
        }
        ++i;
    }

    if (env !== 'development' && env !== 'production') {
        console.log(`Invalid environment ${env}`);
        usage();
        process.exit(1);
    }
}

function loadEnv() {
    process.env.NODE_ENV = env;
    require('../config/env');

    for (let i of ['AWS_REGION', 'AWS_CLOUDFORMATION_STACK', 'AWS_S3_BUCKET', 'AWS_SAM_STAGE_NAME', 'AUTH_URL']) {
        if (!process.env[i].trim()) {
            console.log(`Missing required environment variable ${i}`);
            process.exit(1);
        }
    }

    region = process.env.AWS_REGION;
    bucket = process.env.AWS_S3_BUCKET;
    stack = process.env.AWS_CLOUDFORMATION_STACK;
    stage = process.env.AWS_SAM_STAGE_NAME;
    authUrl = process.env.AUTH_URL;
    allowOrigin = process.env.ALLOW_ORIGIN;
    communicationServicesEndpoint = process.env.AZ_COMMUNICATION_SERVICES_ENDPOINT;
    communicationServicesAccesskey = process.env.AZ_COMMUNICATION_SERVICES_ACCESSKEY;
    hours = process.env.HOURS;
    extraHours = process.env.EXTRA_HOURS;
    holidays = process.env.HOLIDAYS;
    hoursDescription = process.env.HOURS_DESCRIPTION;
    tz = process.env.TZ;

    if (hours && !hours.match(/^(((\d{4}\/\d{4},)*\d{4}\/\d{4})?:){6}((\d{4}\/\d{4},)*\d{4}\/\d{4})?$/)) {
        console.log(`Opening hours are formatted incorrectly`);
        process.exit(1);
    }
    if (extraHours && !extraHours.split(",").every(x => x.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d\/\d\d:\d\d$/))) {
        console.log(`Extra opening hours are formatted incorrectly`);
        process.exit(1);
    }
    if (holidays && !holidays.split(",").every(x => x.match(/^\d{4}-\d\d-\d\d$/))) {
        console.log(`Holidays are formatted incorrectly`);
        process.exit(1);
    }
}

function ensureTools() {
    spawnOrFail('aws', ['--version'], {}, false);
    spawnOrFail('sam', ['--version'], {}, false);
    spawnOrFail('npm', ['install'], {}, false);
}

parseArgs();
loadEnv();
ensureTools();

console.log(`\nStarting build process`);
spawnOrFail('npm', ['run', 'build'], {}, !disablePrintingLogs);

console.log('\nPackaging serverless application');
console.log(`Using region ${region}, bucket ${bucket}`);
ensureBucket();
spawnOrFail(
    'sam',
    ['package', '--s3-bucket', bucket, '--output-template-file', 'build/packaged.yaml', '--region', region],
    {},
    false
);

console.log('\nDeploying serverless application');
console.log(`Deploying to stage ${stage} of stack ${stack}`);
console.log(`Using auth url ${authUrl}, ACS endpoint ${communicationServicesEndpoint}`);
let parameterOverrides = [
    `"Region='${region}'"`,
    `"StageName='${stage}'"`,
    `"AuthUrl='${authUrl}'"`,
    `"AllowOrigin='${allowOrigin || ''}'"`,
    `"CommunicationServicesEndpoint='${communicationServicesEndpoint}'"`,
    `"CommunicationServicesAccesskey='${communicationServicesAccesskey}'"`,
    `"Hours='${hours || ''}'"`,
    `"ExtraHours='${extraHours || ''}'"`,
    `"Holidays='${holidays || ''}'"`,
    `"HoursDescription='${hoursDescription || ''}'"`,
    `"Tz='${tz || ''}'"`
]
    .filter(Boolean);
spawnOrFail(
    'sam',
    [
        'deploy',
        '--template-file',
        'build/packaged.yaml',
        '--stack-name',
        stack,
        '--parameter-overrides',
        ...parameterOverrides,
        '--capabilities',
        'CAPABILITY_IAM',
        '--region',
        region,
        '--no-fail-on-empty-changeset'
    ],
    null,
    !disablePrintingLogs
);

if (!disablePrintingLogs) {
    console.log('Tower backend URL: ');
}
spawnOrFail(
    'aws',
    [
        'cloudformation',
        'describe-stacks',
        '--stack-name',
        stack,
        '--query',
        'Stacks[0].Outputs[0].OutputValue',
        '--output',
        'text',
        '--region',
        region
    ],
    null,
    !disablePrintingLogs
);
