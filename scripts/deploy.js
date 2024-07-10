#!/usr/bin/env node
//
//  deploy.js
//  tower-backend
//
//  Created by Jean-Pierre Höhmann on 2023-04-17.
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

const { spawnSync } = require('child_process');

const { spawnOrFail } = require('./lib');

let region = 'eu-central-1';
let bucket = '';
let stack = '';
let stage = 'Prod';
let authUrl = '';
let allowOrigin = '';
let disablePrintingLogs = false;

function usage() {
    console.log(`Usage: deploy.js -b bucket -s stack --auth-url auth-url`);
    console.log(`Example: deploy.js -b tower-backend -s tower-backend --auth-url https://auth.tower-assist.de`);
    console.log(`Options:`);
    console.log(`  -r, --region                 Target region, default '${region}'`);
    console.log(`  -b, --s3-bucket              S3 bucket for deployment, required`);
    console.log(`  -s, --stack-name             CloudFormation stack name, required`);
    console.log(`  --stage-name                 SAM stage name, default '${stage}'`);
    console.log(`  --auth-url                   Endpoint to check basic auth tokens against, required`);
    console.log(`  --allow-origin               Value for the Access-Control-Allow-Origin CORS-header, optional`);
    console.log(`  -l, --disable-printing-logs  Disable printing logs`);
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
            case '-h':
            case '--help':
                usage();
                process.exit(0);
                break;
            case '-r':
            case '--region':
                region = getArgOrExit(++i, args);
                break;
            case '-b':
            case '--s3-bucket':
                bucket = getArgOrExit(++i, args);
                break;
            case '-s':
            case '--stack-name':
                stack = getArgOrExit(++i, args);
                break;
            case '--stage-name':
                stage = getArgOrExit(++i, args);
                break;
            case '-l':
            case '--disable-printing-logs':
                disablePrintingLogs = true;
                break;
            case '--auth-url':
                authUrl = getArgOrExit(++i, args);
                break;
            case '--allow-origin':
                allowOrigin = getArgOrExit(++i, args);
                break;
            default:
                console.log(`Invalid argument ${args[i]}`);
                usage();
                process.exit(1);
        }
        ++i;
    }

    if (!stack.trim() || !bucket.trim() || !authUrl.trim()) {
        console.log('Missing required parameters');
        usage();
        process.exit(1);
    }
}

function ensureTools() {
    spawnOrFail('aws', ['--version'], {}, false);
    spawnOrFail('sam', ['--version'], {}, false);
    spawnOrFail('npm', ['install'], {}, false);
}

parseArgs();
ensureTools();

console.log(`Starting build process`)
spawnOrFail('npm', ['run', 'build'], {}, !disablePrintingLogs);

console.log('Deploying serverless application');
console.log(`Using region ${region}, bucket ${bucket}, stack ${stack}, stage ${stage}, authUrl ${authUrl}`);
ensureBucket();
spawnOrFail(
    'sam',
    ['package', '--s3-bucket', bucket, '--output-template-file', 'build/packaged.yaml', '--region', region],
    {},
    false
);
let parameterOverrides
    = `Region=${region} StageName=${stage} AuthUrl=${authUrl} ${allowOrigin && "AllowOrigin=" + allowOrigin}`;
spawnOrFail(
    'sam',
    [
        'deploy',
        '--template-file',
        'build/packaged.yaml',
        '--stack-name',
        stack,
        '--parameter-overrides',
        parameterOverrides,
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
