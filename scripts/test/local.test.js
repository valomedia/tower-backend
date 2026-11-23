/*
 * Copyright (c) 2026 valo.media GmbH
 * All rights reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {setTimeout: delay} = require('node:timers/promises');
const {readTemplate, localSettings, createLocalTemplate, tableDefinitions, isolatedEnvironment} = require('../local-config');
const {run, waitUntilReady, removeDockerResources} = require('../local');

const root = path.resolve(__dirname, '../..');
const template = readTemplate(fs.readFileSync(path.join(root, 'template.yaml'), 'utf8'));
const settings = localSettings({});

function references(value) {
    if (!value || typeof value !== 'object') {return [];}
    if (value.Ref) {return [value.Ref];}
    if (value['Fn::GetAtt']) {return [value['Fn::GetAtt'][0]];}
    return Object.values(value).flatMap(references);
}

test('local template preserves routes, authorizer and runtime without deployable storage or secrets', () => {
    const before = structuredClone(template);
    const generated = createLocalTemplate(template, path.join(root, 'build'), settings);
    const functions = Object.entries(template.Resources).filter(([, resource]) => resource.Type === 'AWS::Serverless::Function');
    assert.equal(Object.keys(generated.Resources).length, functions.length + 1);
    for (const [name, resource] of functions) {
        const local = generated.Resources[name];
        assert.equal(local.Properties.Handler, resource.Properties.Handler);
        assert.deepEqual(local.Properties.Events, resource.Properties.Events);
        assert.equal(local.Properties.CodeUri, path.join(root, 'build'));
        assert.equal(local.Properties.Policies, undefined);
    }
    assert.deepEqual(generated.Resources.TowerApi.Properties.Auth, template.Resources.TowerApi.Properties.Auth);
    assert.equal(generated.Globals.Function.Runtime, template.Globals.Function.Runtime);
    assert.equal(generated.Globals.Function.Timeout, template.Globals.Function.Timeout);
    assert.equal(generated.Resources.BasicAuthLambda.Properties.Handler, 'handlers.authHandler');
    assert.equal(generated.Resources.TowerApi.Properties.Cors.AllowHeaders, "'Authorization,Content-Type'");
    assert.equal(generated.Parameters.AllowOrigin.Default, 'http://localhost:3000');
    assert.equal(generated.Parameters.AuthUrl.Default, 'https://unused.invalid');
    assert.equal(generated.Outputs, undefined);
    assert.equal(generated.Conditions, undefined);
    const variables = generated.Globals.Function.Environment.Variables;
    assert.ok(Object.values(variables).every(value => typeof value === 'string'));
    assert.equal(variables.TOWER_LOCAL, 'true');
    assert.equal(variables.AWS_SAM_LOCAL, undefined); // Only SAM may supply the second gate.
    assert.equal(variables.TOWER_LOCAL_DYNAMODB_ENDPOINT, 'http://dynamodb:8000');
    assert.equal(variables.TOWER_LOCAL_S3_ENDPOINT, 'http://127.0.0.1:4569');
    assert.equal(variables.ASSISTANCE_REQUESTS_TABLE_NAME, 'AssistanceRequests');
    assert.equal(variables.CALL_RECORDS_TABLE_NAME, 'CallRecords');
    assert.equal(variables.COMMUNICATION_USER_IDS_TABLE_NAME, 'CommunicationUserIds');
    assert.equal(variables.USER_PROFILES_TABLE_NAME, 'UserProfiles');
    assert.equal(variables.UPLOAD_BUCKET, 'tower-local-uploads');
    for (const key of ['HOURS', 'EXTRA_HOURS', 'HOLIDAYS', 'MAIL_FROM_ADDRESS',
        'COMMUNICATION_SERVICES_ENDPOINT', 'COMMUNICATION_SERVICES_ACCESSKEY']) {
        assert.equal(variables[key], '');
    }
    for (const name of references(generated)) {
        assert.ok(generated.Resources[name] || generated.Parameters[name], `Unresolved reference: ${name}`);
    }
    assert.deepEqual(template, before);
    assert.equal(template.Globals.Function.Environment.Variables.TOWER_LOCAL, undefined);
});

test('database bootstrap derives all keys and secondary indexes from the deployment template', () => {
    const definitions = tableDefinitions(template);
    assert.deepEqual(definitions.map(table => table.TableName),
        ['AssistanceRequests', 'CallRecords', 'CommunicationUserIds', 'UserProfiles']);
    for (const definition of definitions) {
        const properties = template.Resources[definition.TableName].Properties;
        assert.deepEqual(definition.KeySchema, properties.KeySchema);
        assert.deepEqual(definition.AttributeDefinitions, properties.AttributeDefinitions);
        assert.deepEqual(definition.GlobalSecondaryIndexes, properties.GlobalSecondaryIndexes);
        assert.equal(definition.BillingMode, properties.BillingMode);
        assert.equal(definition.TimeToLiveSpecification, undefined);
    }
    assert.equal(definitions[0].GlobalSecondaryIndexes[0].IndexName, 'DateTime');
    assert.equal(definitions[3].GlobalSecondaryIndexes[0].IndexName, 'Email');
    definitions[0].KeySchema[0].AttributeName = 'mutated';
    assert.equal(template.Resources.AssistanceRequests.Properties.KeySchema[0].AttributeName, 'Username');
});

test('SAM environment ignores ambient cloud credentials, config and deployment variables', () => {
    const source = Object.freeze({
        PATH: '/bin', DOCKER_HOST: 'unix:///var/run/docker.sock', BUILD_PATH: 'elsewhere',
        AWS_PROFILE: 'production', AWS_SESSION_TOKEN: 'test-session', AWS_ACCESS_KEY_ID: 'test-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_CONFIG_FILE: '/some/config',
        AWS_SHARED_CREDENTIALS_FILE: '/some/credentials', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://example.test',
        AWS_WEB_IDENTITY_TOKEN_FILE: '/some/token', AWS_ENDPOINT_URL: 'https://example.test',
        SAM_CLI_TELEMETRY: '1', TOWER_LOCAL: 'false', TOWER_LOCAL_S3_ENDPOINT: 'https://example.test',
        AUTH_URL: 'https://example.test', COMMUNICATION_SERVICES_ACCESSKEY: 'test-acs', MAIL_FROM_ADDRESS: 'test@example.test'
    });
    const env = isolatedEnvironment(Object.keys(template.Globals.Function.Environment.Variables), '/local', source);
    assert.equal(env.PATH, source.PATH);
    assert.equal(env.DOCKER_HOST, source.DOCKER_HOST);
    assert.equal(env.AWS_ACCESS_KEY_ID, 'local');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'local');
    assert.equal(env.AWS_REGION, 'eu-central-1');
    assert.equal(env.AWS_CONFIG_FILE, '/local/aws-config');
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, '/local/aws-credentials');
    assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
    assert.equal(env.SAM_CLI_TELEMETRY, '0');
    for (const name of ['AWS_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
        'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_ENDPOINT_URL', 'TOWER_LOCAL', 'TOWER_LOCAL_S3_ENDPOINT',
        'AUTH_URL', 'COMMUNICATION_SERVICES_ACCESSKEY', 'MAIL_FROM_ADDRESS']) {
        assert.equal(env[name], undefined, name);
    }
});

test('local settings validate ports and a single CORS origin', () => {
    assert.deepEqual(settings, {port: 3001, samPort: 3002, s3Port: 4569, origin: 'http://localhost:3000'});
    const custom = localSettings({TOWER_LOCAL_PORT: '3100', TOWER_LOCAL_S3_PORT: '4570',
        TOWER_LOCAL_ORIGIN: 'http://localhost:5173'});
    const generated = createLocalTemplate(template, 'build', custom);
    assert.equal(generated.Parameters.AllowOrigin.Default, custom.origin);
    assert.equal(generated.Globals.Function.Environment.Variables.TOWER_LOCAL_S3_ENDPOINT, 'http://127.0.0.1:4570');
    for (const port of ['abc', '0', '-1', '3.5', '1023', '65536']) {
        for (const key of ['TOWER_LOCAL_PORT', 'TOWER_LOCAL_SAM_PORT', 'TOWER_LOCAL_S3_PORT']) {
            assert.throws(() => localSettings({[key]: port}), /ports/);
        }
    }
    assert.equal(localSettings({TOWER_LOCAL_SAM_PORT: '3102'}).samPort, 3102);
    assert.throws(() => localSettings({TOWER_LOCAL_PORT: '4569'}), /differ/);
    assert.throws(() => localSettings({TOWER_LOCAL_PORT: '3002'}), /differ/);
    assert.throws(() => localSettings({TOWER_LOCAL_SAM_PORT: '4569'}), /differ/);
    for (const origin of ['*', 'file:///tmp', 'https://example.test/', 'https://example.test/path',
        'http://user:password@localhost:3000', 'http://localhost:3000?query', "http://localhost:3000'\n"]) {
        assert.throws(() => localSettings({TOWER_LOCAL_ORIGIN: origin}));
    }
});

test('opt-in DinD devcontainer reuses the default Dockerfile without host socket or credential mounts', () => {
    const directory = path.join(root, '.devcontainer/docker');
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'devcontainer.json'), 'utf8'));
    assert.equal(config.name, '${containerWorkspaceFolderBasename}');
    assert.ok(fs.existsSync(path.resolve(directory, config.build.dockerfile)));
    assert.equal(path.resolve(directory, config.build.context), root);
    assert.ok(config.features['ghcr.io/devcontainers/features/docker-in-docker:2']);
    assert.equal(config.mounts, undefined);
    assert.equal(config.runArgs, undefined);
    assert.ok(config.customizations.vscode);
    assert.ok(config.customizations.jetbrains);
    assert.deepEqual(config.forwardPorts, [settings.port, settings.s3Port]);
    assert.ok(config.portsAttributes['4569'].requireLocalPort);
    const standard = JSON.parse(fs.readFileSync(path.join(root, '.devcontainer/devcontainer.json'), 'utf8'));
    assert.equal(standard.features['ghcr.io/devcontainers/features/docker-in-docker:2'], undefined);
});

test('process runner propagates startup and command failures', async () => {
    assert.equal(await run(process.execPath, ['-e', 'console.log("ready")']), 'ready');
    await assert.rejects(run('tower-nonexistent-command', []), /ENOENT/);
    await assert.rejects(run(process.execPath, ['-e', 'console.error("failed"); process.exit(7)']), /failed \(7\).*failed/s);
});

test('process runner waits for a cancelled child to exit and enforces timeouts', async () => {
    const controller = new AbortController();
    const child = run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {signal: controller.signal});
    const error = new Error('cancelled');
    controller.abort(error);
    await assert.rejects(child, error);
    await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {timeout: 100}), /timeout/);
    assert.throws(() => run(process.execPath, [], {signal: controller.signal}), error);
});

test('cancellation also stops descendants after the direct child exits', {skip: process.platform === 'win32'}, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-process-test-'));
    const heartbeat = path.join(directory, 'heartbeat');
    const controller = new AbortController();
    const descendant = `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(${JSON.stringify(path.join(directory, 'pid'))}, String(process.pid));
        setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20);
    `;
    const script = `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'ignore'});
        setInterval(() => {}, 1000);
    `;
    const child = run(process.execPath, ['-e', script], {signal: controller.signal});
    try {
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(heartbeat) && Date.now() < deadline) {await delay(20);}
        assert.ok(fs.existsSync(heartbeat), 'descendant must start');
        controller.abort(new Error('cancelled'));
        await assert.rejects(child, /cancelled/);
        const stopped = fs.readFileSync(heartbeat, 'utf8');
        await delay(100);
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), stopped, 'descendant must stop before run settles');
    } finally {
        controller.abort(new Error('test cleanup'));
        await child.catch(() => {});
        const pidFile = path.join(directory, 'pid');
        if (fs.existsSync(pidFile)) {
            try {process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');}
            catch (error) {if (error.code !== 'ESRCH') {throw error;}}
        }
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('cleanup removes only owned services and Lambda containers on the unique run network', async () => {
    const calls = [];
    const containers = ['tower-run-db', 'tower-run-s3'];
    await removeDockerResources(containers, 'tower-run', async (command, args, options) => {
        assert.equal(command, 'docker');
        assert.equal(options.timeout, 15_000);
        calls.push(args);
        return args[0] === 'ps' ? 'lambda-one\nlambda-two' : '';
    });
    assert.deepEqual(calls, [
        ['rm', '--force', 'tower-run-s3'],
        ['rm', '--force', 'tower-run-db'],
        ['ps', '--all', '--quiet', '--filter', 'network=tower-run'],
        ['rm', '--force', 'lambda-one', 'lambda-two'],
        ['network', 'rm', 'tower-run']
    ]);
    assert.deepEqual(containers, ['tower-run-db', 'tower-run-s3']);
});

test('cleanup attempts remaining resources and reports failures', async () => {
    const calls = [];
    await assert.rejects(removeDockerResources(['tower-run-db'], 'tower-run', async (_command, args) => {
        calls.push(args);
        if (args.includes('tower-run-db')) {throw new Error('cannot remove database');}
        return '';
    }), /cleanup failed.*cannot remove database/s);
    assert.deepEqual(calls.at(-1), ['network', 'rm', 'tower-run']);
});

test('readiness retries transient failures and respects cancellation', async () => {
    let attempts = 0;
    const controller = new AbortController();
    await waitUntilReady('test service', async () => {
        if (++attempts < 2) {throw new Error('not ready');}
    }, controller.signal);
    assert.equal(attempts, 2);
    controller.abort(new Error('cancelled'));
    await assert.rejects(waitUntilReady('test service', async () => {}, controller.signal), /cancelled/);
});
