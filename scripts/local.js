#!/usr/bin/env node
/*
 * Copyright (c) 2026 valo.media GmbH
 * All rights reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const {randomUUID} = require('node:crypto');
const {region, credentials, bucket, readTemplate, localSettings, createLocalTemplate,
    tableDefinitions, isolatedEnvironment} = require('./local-config');
const {startLocalProxy} = require('./local-proxy');

const bootstrapRequestHandler = {connectionTimeout: 1000, requestTimeout: 2000, throwOnRequestTimeout: true};

// renovate: datasource=docker depName=amazon/dynamodb-local
const dynamodbImage = 'amazon/dynamodb-local:3.3.0';
// renovate: datasource=docker depName=adobe/s3mock
const s3Image = 'adobe/s3mock:5.1.0';

function run(command, args, {signal, inherit = false, timeout = 0, ...options} = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(command, args, {...options, detached: grouped,
            stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']});
        let stdout = '';
        let stderr = '';
        let spawnError;
        let termination;
        let timedOut = false;
        function kill(killSignal) {
            if (!child.pid) {return;}
            try {
                if (grouped) {process.kill(-child.pid, killSignal);}
                else {child.kill(killSignal);}
            } catch (error) {
                if (error.code !== 'ESRCH') {throw error;}
            }
        }
        async function terminate() {
            kill('SIGTERM');
            // The group leader can exit before its descendants.
            // Wait for escalation before settling, even if the direct child has closed.
            await delay(5000);
            kill('SIGKILL');
        }
        function stop() {
            termination ??= terminate();
            termination.catch(reject);
        }
        const timer = timeout ? setTimeout(() => {timedOut = true; stop();}, timeout) : undefined;
        signal?.addEventListener('abort', stop, {once: true});
        child.stdout?.on('data', data => {stdout += data;});
        child.stderr?.on('data', data => {stderr += data;});
        child.on('error', error => {spawnError = error;});
        child.on('close', async (code, exitSignal) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            try {
                await termination;
                if (spawnError) {reject(spawnError);}
                else if (signal?.aborted) {reject(signal.reason);}
                else if (code !== 0 || timedOut) {
                    reject(new Error(`${command} ${args[0]} failed (${timedOut ? 'timeout' : exitSignal || code})\n${stderr}`));
                } else {resolve(stdout.trim());}
            } catch (error) {reject(error);}
        });
    });
}

async function waitUntilReady(name, check, signal, timeout = 90_000) {
    const deadline = new AbortController();
    const readinessSignal = AbortSignal.any([signal, deadline.signal]);
    let lastError;
    const timer = setTimeout(() => deadline.abort(
        new Error(`${name} did not become ready within ${timeout / 1000} seconds`, {cause: lastError})
    ), timeout);
    try {
        while (true) {
            readinessSignal.throwIfAborted();
            try {
                await check(readinessSignal);
                readinessSignal.throwIfAborted();
                return;
            } catch (error) {
                readinessSignal.throwIfAborted();
                lastError = error;
            }
            await delay(500, undefined, {signal: readinessSignal});
        }
    } catch (error) {
        readinessSignal.throwIfAborted();
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function removeDockerResources(containers, network, execute = run) {
    const errors = [];
    async function remove(args) {
        try {return await execute('docker', args, {timeout: 15_000});}
        catch (error) {errors.push(error.message);}
    }
    for (const container of [...containers].reverse()) {
        await remove(['rm', '--force', container]);
    }
    if (network) {
        // Interrupted SAM invocations may leave Lambda containers on this run's network.
        const remaining = await remove(['ps', '--all', '--quiet', '--filter', `network=${network}`]);
        if (remaining) {await remove(['rm', '--force', ...remaining.split(/\s+/)]);}
        await remove(['network', 'rm', network]);
    }
    if (errors.length) {throw new Error(`Local Docker cleanup failed:\n${errors.join('\n')}`);}
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const settings = localSettings();
    const template = readTemplate(await fs.readFile(path.join(root, 'template.yaml'), 'utf8'));
    const controller = new AbortController();
    const signal = controller.signal;
    function interrupt(name) {
        process.exitCode = name === 'SIGINT' ? 130 : 143;
        controller.abort(new Error(`Stopped by ${name}`));
    }
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    const name = `tower-local-${randomUUID()}`;
    const containers = [];
    let networkCreated = false;
    let directory;
    let ddb;
    let s3;
    let proxy;
    try {
        await run('sam', ['--version'], {signal, timeout: 15_000});
        await run('docker', ['info'], {signal, timeout: 15_000});
        await fs.mkdir(path.join(root, '.local'), {recursive: true});
        directory = await fs.mkdtemp(path.join(root, '.local/run-'));
        for (const file of ['aws-config', 'aws-credentials']) {
            await fs.writeFile(path.join(directory, file), '');
        }
        await fs.writeFile(path.join(directory, 'samconfig.toml'), 'version = 0.1\n');
        const env = isolatedEnvironment(Object.keys(template.Globals.Function.Environment.Variables), directory);
        const buildPath = path.join(root, 'build');
        await run('npm', ['run', 'build'], {cwd: root, env: {...env, BUILD_PATH: buildPath}, inherit: true, signal});
        const localTemplate = createLocalTemplate(template, buildPath, settings);
        const templatePath = path.join(directory, 'template.json');
        await fs.writeFile(templatePath, JSON.stringify(localTemplate, null, 2));

        networkCreated = true;
        await run('docker', ['network', 'create', name], {signal, timeout: 30_000});
        containers.push(`${name}-db`);
        await run('docker', ['run', '--detach', '--rm', '--name', containers[0],
            '--network', name, '--network-alias', 'dynamodb', '--publish', '127.0.0.1::8000',
            dynamodbImage, '-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb'], {signal, timeout: 300_000});
        containers.push(`${name}-s3`);
        await run('docker', ['run', '--detach', '--rm', '--name', containers[1],
            '--publish', `127.0.0.1:${settings.s3Port}:9090`, s3Image], {signal, timeout: 300_000});
        const binding = await run('docker', ['port', containers[0], '8000/tcp'], {signal, timeout: 15_000});
        if (!/^127\.0\.0\.1:[0-9]+$/.test(binding)) {throw new Error(`Unexpected DynamoDB port binding: ${binding}`);}

        // Bootstrap using the Lambda project's SDK dependencies installed by the build.
        const {DynamoDBClient, ListTablesCommand, CreateTableCommand} = require('../src/node_modules/@aws-sdk/client-dynamodb');
        const {S3Client, ListBucketsCommand, CreateBucketCommand} = require('../src/node_modules/@aws-sdk/client-s3');
        const clientOptions = {region, credentials, maxAttempts: 1, requestHandler: bootstrapRequestHandler};
        ddb = new DynamoDBClient({...clientOptions, endpoint: `http://${binding}`});
        s3 = new S3Client({...clientOptions, endpoint: `http://127.0.0.1:${settings.s3Port}`, forcePathStyle: true});
        await waitUntilReady('DynamoDB Local', abortSignal => ddb.send(new ListTablesCommand({}), {abortSignal}), signal);
        await waitUntilReady('S3Mock', abortSignal => s3.send(new ListBucketsCommand({}), {abortSignal}), signal);
        for (const definition of tableDefinitions(template)) {
            await ddb.send(new CreateTableCommand(definition), {abortSignal: signal});
        }
        await s3.send(new CreateBucketCommand({Bucket: bucket}), {abortSignal: signal});

        proxy = await startLocalProxy(settings);
        console.log(`\nLocal-only API: http://127.0.0.1:${settings.port}`);
        console.log('Any Basic credentials are accepted. ACS is mocked and mail is disabled.');
        console.log('Do not expose these ports publicly. Ctrl+C removes this run’s containers and data.\n');
        await run('sam', ['local', 'start-api', '--template', templatePath,
            '--config-file', path.join(directory, 'samconfig.toml'), '--region', region,
            '--host', '127.0.0.1', '--port', String(settings.samPort), '--docker-network', name],
        {cwd: root, env, inherit: true, signal});
    } finally {
        await proxy?.close().catch(error => {
            console.error(`Local API cleanup failed: ${error.message}`);
            process.exitCode ||= 1;
        });
        ddb?.destroy();
        s3?.destroy();
        // Cleanup is deliberately not cancelled by the signal that stopped SAM.
        await removeDockerResources(containers, networkCreated ? name : undefined).catch(error => {
            console.error(error.message);
            process.exitCode ||= 1;
        });
        if (directory) {await fs.rm(directory, {recursive: true, force: true});}
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        if (error.cause) {console.error(error.cause.message);}
        process.exitCode ||= 1;
    });
}

module.exports = {run, waitUntilReady, removeDockerResources, bootstrapRequestHandler};
