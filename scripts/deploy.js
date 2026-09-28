#!/usr/bin/env node
//
//  deploy.js
//  tower-backend
//
//  Copyright © 2024 valo.media GmbH. All rights reserved.
//

// NODE_ENV should always be production.
process.env.NODE_ENV = 'production';

// Makes the script crash on unhandled rejections instead of silently ignoring them. In the future, promise rejections
// that are not handled will terminate the Node.js process with a non-zero exit code.
process.on('unhandledRejection', err => {
    throw err
});

const { spawnSync } = require('child_process');
const dotenv = require('@dotenvx/dotenvx');

const { spawnOrFail } = require('./lib');
const env = require('../config/env');

let
    config,
    region,
    profile,
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
    tz,
    mailFromAddress,
    mailDomain,
    sourceUrl;

let disablePrintingLogs = false;

function usage() {
    console.log(`Usage: deploy.js [--config <config>] [-l] [-h]`);
    console.log(`Example: deploy.js --config development`);
    console.log(`Options:`);
    console.log(`  --config                     Configuration to deploy, optional'`);
    console.log(`  -l, --disable-printing-logs  Make the output less verbose`);
    console.log(`  -h, --help                   Show help and exit`);
}

function ensureBucket() {
    const s3Api = spawnSync(
        'aws',
        [
            's3api',
            'head-bucket',
            '--bucket',
            bucket,
            '--region',
            region,
            ...(profile ? ['--profile', profile] : [])
        ]
    );
    if (s3Api.status !== 0) {
        console.log(`Creating S3 bucket ${bucket}`);
        const s3 = spawnSync(
            'aws',
            [
                's3',
                'mb',
                `s3://${bucket}`,
                '--region',
                region,
                ...(profile ? ['--profile', profile] : [])
            ]
        );
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
            case '--config':
                 config = getArgOrExit(++i, args);
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
}

function loadEnv() {
    dotenv.config({ path: env(config) });

    for (let i of [
        'AWS_REGION',
        'AWS_CLOUDFORMATION_STACK',
        'AWS_S3_BUCKET',
        'AWS_SAM_STAGE_NAME',
        'AUTH_URL',
        'SOURCE_URL'
    ]) {
        if (!process.env[i] || !process.env[i].trim()) {
            console.log(`Missing required environment variable ${i}`);
            process.exit(1);
        }
    }
    region = process.env.AWS_REGION;
    profile = process.env.AWS_PROFILE;
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
    mailFromAddress = process.env.MAIL_FROM_ADDRESS;
    mailDomain = mailFromAddress
        ? (mailFromAddress.match(/<([^>]+)>\s*$/)?.[1] ?? mailFromAddress).split('@')[1] ?? ''
        : '';
    sourceUrl = process.env.SOURCE_URL;

    if (mailFromAddress && !mailDomain) {
        console.log(`Could not extract a domain from MAIL_FROM_ADDRESS=${mailFromAddress}`);
        process.exit(1);
    }

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
    [
        'package',
        '--s3-bucket',
        bucket,
        '--output-template-file',
        'build/packaged.yaml',
        '--region',
        region,
        ...(profile ? ['--profile', profile] : [])
    ],
    {},
    false
);

console.log('\nDeploying serverless application');
console.log(`Deploying to stage ${stage} of stack ${stack}`);
console.log(`Using auth url ${authUrl}, ACS endpoint ${communicationServicesEndpoint}`);
// Each entry is wrapped as Key="Value" so SAM accepts empty values and any whitespace in the value. SAM strips a
// matching outer pair of quotes before parsing the Key=Value pair.
let parameterOverrides = [
    ['StageName', stage],
    ['AuthUrl', authUrl],
    ['AllowOrigin', allowOrigin],
    ['CommunicationServicesEndpoint', communicationServicesEndpoint],
    ['CommunicationServicesAccesskey', communicationServicesAccesskey],
    ['Hours', hours],
    ['ExtraHours', extraHours],
    ['Holidays', holidays],
    ['HoursDescription', hoursDescription],
    ['Tz', tz],
    ['MailFromAddress', mailFromAddress],
    ['MailDomain', mailDomain],
    ['SourceUrl', sourceUrl]
].map(([key, value]) => `${key}="${value || ''}"`);
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
        ...(profile ? ['--profile', profile] : []),
        '--no-fail-on-empty-changeset'
    ],
    null,
    !disablePrintingLogs
);

printStackOutputs();

function printStackOutputs() {
    const json = spawnOrFail(
        'aws',
        [
            'cloudformation',
            'describe-stacks',
            '--stack-name',
            stack,
            '--query',
            'Stacks[0].Outputs',
            '--output',
            'json',
            '--region',
            region,
            ...(profile ? ['--profile', profile] : [])
        ],
        null,
        false
    );
    const outputs = JSON.parse(json);
    const dnsRecords = [];
    const other = [];
    for (const o of outputs) {
        const m = o.OutputValue.match(/^(\S+)\s+IN\s+(CNAME|MX|TXT)\s+(.+)$/);
        if (m) {
            dnsRecords.push({ name: m[1], type: m[2], value: m[3] });
        } else {
            other.push(o);
        }
    }
    for (const o of other) {
        console.log(`${o.OutputKey}: ${o.OutputValue}`);
    }
    if (dnsRecords.length) {
        dnsRecords.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
        const nameW = Math.max(...dnsRecords.map(r => r.name.length));
        const typeW = Math.max(...dnsRecords.map(r => r.type.length));
        console.log('\nDNS records to add (zone file format):\n');
        for (const r of dnsRecords) {
            console.log(`${r.name.padEnd(nameW)} IN ${r.type.padEnd(typeW)} ${r.value}`);
        }
    }
}
