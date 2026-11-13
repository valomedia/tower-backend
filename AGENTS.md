# AGENTS.md – Tower Backend

## Project Overview

This repository is the AWS SAM backend for Tower.
The Lambda source is TypeScript under `src/`,
and the infrastructure template is `template.yaml`.

Runtime resources include API Gateway, Lambda, DynamoDB, S3, SES,
and Azure Communication Services integration.

## Layout

- `src/handlers.ts` wires exported Lambda handlers to real cloud services and production authentication.
- `src/application.ts` contains shared handler logic with explicit configuration and dependencies.
- `src/local/` contains the local HTTP server and in-memory service adapters.
- `src/helpers.ts` and `src/types.ts` contain shared helper logic and data shapes.
- `src/test/` contains Node test-runner helper, handler, and local HTTP integration tests.
- `template.yaml` defines the SAM application and handler wiring.
- `scripts/` contains root orchestration scripts for build, test, clean, and deploy.
- `config/paths.js` and `config/env.js` centralize script paths and env-file loading.
- `build/`, `build-test/`, and `build-local/` are generated outputs and must not be hand-edited.

## Dependency Model

There are two npm projects:

- The repository root contains orchestration dependencies used by `scripts/`.
- `src/package.json` contains Lambda runtime dependencies and TypeScript/test dependencies.

Run root commands from the repository root.
The root test and build scripts install dependencies in `src/` as needed.
Do not move Lambda dependencies into the root package unless the runtime/build layout changes too.

## Common Commands

- `npm ci` installs the root script dependencies.
- `npm test` installs `src` dependencies, compiles tests with `src/tsconfig.test.json`,
  and runs `node --test` against `build-test/test/*.test.js`.
- `npm run lint` installs `src` dependencies and runs ESLint against the TypeScript source.
- `npm run build` installs `src` dependencies,
  prepares production dependencies in `build/`,
  and compiles `src/handlers.ts` using the root `tsconfig.json`.
- `npm run dev` installs `src` dependencies, compiles `src/tsconfig.local.json`,
  and starts the ephemeral local server on `127.0.0.1:3001`.
  Restart it after source changes; it does not watch files.
- `npm run clean` empties `build/`.
- `npm run deploy -- --config development` deploys the development configuration.
- `npm run deploy -- --config production` deploys the production configuration.

Before handing off code changes, run at least `npm test` and `npm run build`
when the change can affect TypeScript, tests, handlers, package files, or the SAM template.

## TypeScript and JavaScript Conventions

- TypeScript is compiled with `strict`, `noImplicitAny`, `moduleResolution: node16`,
  and `module: node16`.
- Keep Lambda source in `src/` as TypeScript modules using existing import style.
- Keep root/config/scripts code as CommonJS JavaScript.
- Preserve the existing API Gateway proxy response shape returned by `response()`.
- Prefer small helper functions in `src/helpers.ts` for behavior that can be tested without AWS services.
- Use AWS SDK v3 command/client patterns consistently with the existing handlers.

## Configuration and Secrets

Tracked `.env`, `.env.development`, and `.env.production` files provide default configuration values.
Local overrides use `.env.local`, `.env.<config>.local`, `.secrets`,
and `.secrets.<config>`, which are ignored by git.

Never commit secrets, access keys, or deployment-only local configuration.
Do not read or print secret files unless the task explicitly requires it.

## Local Server Boundaries

- Never import `src/local/` from the production entry point or add an authentication-bypass environment flag.
  Local startup uses explicit mocks and must not load `config/env.js` or deployment secrets.
- Keep `LOCAL_ROUTES` synchronized with SAM routes and authorization;
  `src/test/local.test.ts` checks parity and blocks non-loopback connections.
- The memory database only supports commands used by the shared handlers.
  Extend its implementation and tests together when adding persistence operations.
- Keep Docker-in-Docker opt-in under `.devcontainer/docker/devcontainer.json`.
  Do not enable it in the standard devcontainer.

## Deployment Safety

Deployment requires authenticated `aws` and `sam` CLIs and can change AWS resources.
Do not run `npm run deploy`, `sam deploy`, or equivalent deployment commands
unless the user explicitly asks for a deployment.

The deployment script packages the application into the configured S3 bucket
and deploys the CloudFormation stack named by the environment configuration.

## Generated Files and Artifacts

Do not hand-edit or commit generated output under:

- `build/`
- `build-test/`
- `build-local/`
- `node_modules/`
- `src/node_modules/`

Package-lock files are source files for reproducible installs.
Update the root lockfile with root dependency changes,
and update `src/package-lock.json` with Lambda dependency or test dependency changes.
