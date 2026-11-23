/*
 * Copyright (c) 2026 valo.media GmbH
 * All rights reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const yaml = require('js-yaml');
const path = require('node:path');

const region = 'eu-central-1';
const credentials = {accessKeyId: 'local', secretAccessKey: 'local'};
const bucket = 'tower-local-uploads';

// Preserve CloudFormation intrinsics when converting the deployment template to JSON.
const schema = yaml.DEFAULT_SCHEMA.extend(
    ['Ref', 'GetAtt', 'Sub', 'Not', 'Equals'].flatMap(tag =>
        ['scalar', 'sequence'].map(kind => new yaml.Type(`!${tag}`, {
            kind,
            construct: value => ({[tag === 'Ref' ? tag : `Fn::${tag}`]:
                tag === 'GetAtt' && typeof value === 'string' ? value.split('.') : value})
        }))
    )
);

function readTemplate(source) {
    return yaml.load(source, {schema});
}

function localSettings(env = process.env) {
    const port = Number(env.TOWER_LOCAL_PORT || 3001);
    const samPort = Number(env.TOWER_LOCAL_SAM_PORT || 3002);
    const s3Port = Number(env.TOWER_LOCAL_S3_PORT || 4569);
    const ports = [port, samPort, s3Port];
    for (const value of ports) {
        if (!Number.isInteger(value) || value < 1024 || value > 65535) {
            throw new Error('Local ports must be integers between 1024 and 65535');
        }
    }
    if (new Set(ports).size !== ports.length) {throw new Error('API, SAM and S3 ports must differ');}
    const origin = env.TOWER_LOCAL_ORIGIN || 'http://localhost:3000';
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
        throw new Error('TOWER_LOCAL_ORIGIN must be a single HTTP(S) origin without a trailing slash');
    }
    return {port, samPort, s3Port, origin};
}

function createLocalTemplate(template, buildPath, settings) {
    const local = structuredClone(template);
    delete local.Conditions;
    delete local.Outputs;
    const defaults = {
        AuthUrl: 'https://unused.invalid',
        AllowOrigin: settings.origin,
        StageName: 'Local',
        Tz: 'Europe/Berlin',
        SourceUrl: 'https://github.com/valomedia/tower-backend'
    };
    for (const [name, parameter] of Object.entries(local.Parameters)) {
        parameter.Default = defaults[name] ?? parameter.Default ?? '';
    }
    const values = Object.fromEntries(Object.entries(local.Parameters).map(([name, parameter]) => [name, parameter.Default]));
    for (const [name, resource] of Object.entries(local.Resources)) {
        if (resource.Type === 'AWS::DynamoDB::Table') {values[name] = name;}
        if (resource.Type === 'AWS::S3::Bucket') {values[name] = bucket;}
        if (resource.Type === 'AWS::Serverless::Function') {
            resource.Properties.CodeUri = path.resolve(buildPath);
            delete resource.Properties.Policies;
        } else if (resource.Type !== 'AWS::Serverless::Api') {
            delete local.Resources[name];
        }
    }
    const environment = local.Globals.Function.Environment.Variables;
    for (const [name, value] of Object.entries(environment)) {
        if (typeof value === 'object') {
            if (!value.Ref || values[value.Ref] === undefined) {
                throw new Error(`Cannot resolve local environment variable ${name}`);
            }
            environment[name] = String(values[value.Ref]);
        }
    }
    Object.assign(environment, {
        TOWER_LOCAL: 'true',
        TOWER_LOCAL_DYNAMODB_ENDPOINT: 'http://dynamodb:8000',
        TOWER_LOCAL_S3_ENDPOINT: `http://127.0.0.1:${settings.s3Port}`,
        MAIL_FROM_ADDRESS: '',
        COMMUNICATION_SERVICES_ENDPOINT: '',
        COMMUNICATION_SERVICES_ACCESSKEY: ''
    });
    local.Resources.TowerApi.Properties.Cors.AllowHeaders = "'Authorization,Content-Type'";
    return local;
}

function tableDefinitions(template) {
    const properties = ['AttributeDefinitions', 'KeySchema', 'BillingMode', 'GlobalSecondaryIndexes',
        'LocalSecondaryIndexes', 'ProvisionedThroughput'];
    return Object.entries(template.Resources)
        .filter(([, resource]) => resource.Type === 'AWS::DynamoDB::Table')
        .map(([name, resource]) => ({
            TableName: name,
            ...Object.fromEntries(properties.filter(key => resource.Properties[key] !== undefined)
                .map(key => [key, structuredClone(resource.Properties[key])]))
        }));
}

function isolatedEnvironment(environmentNames, directory, env = process.env) {
    const isolated = Object.fromEntries(Object.entries(env).filter(([name]) =>
        !/^(AWS_|SAM_|TOWER_LOCAL)/.test(name) && !environmentNames.includes(name)
    ));
    return {
        ...isolated,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_REGION: region,
        AWS_DEFAULT_REGION: region,
        AWS_CONFIG_FILE: path.join(directory, 'aws-config'),
        AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'aws-credentials'),
        AWS_EC2_METADATA_DISABLED: 'true',
        SAM_CLI_TELEMETRY: '0'
    };
}

module.exports = {region, credentials, bucket, readTemplate, localSettings, createLocalTemplate,
    tableDefinitions, isolatedEnvironment};
