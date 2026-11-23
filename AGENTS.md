# AGENTS.md – Tower Backend

## Project Overview

This repository is the AWS SAM backend for Tower.
The Lambda source is TypeScript under `src/`,
and the infrastructure template is `template.yaml`.

Runtime resources include API Gateway, Lambda, DynamoDB, S3, SES,
and Azure Communication Services integration.

## Layout

- `src/handlers.ts` contains the exported Lambda handlers.
- `src/helpers.ts` and `src/types.ts` contain shared helper logic and data shapes.
- `src/test/` contains Node test-runner tests for helper behavior.
- `template.yaml` defines the SAM application and handler wiring.
- `scripts/` contains root orchestration scripts for build, test, clean, and deploy.
- `config/paths.js` and `config/env.js` centralize script paths and env-file loading.
- `build/` and `build-test/` are generated outputs and must not be hand-edited.

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
  and runs `node --test` against `build-test/test/*.test.js`
  and the root orchestration tests in `scripts/test/`.
- `npm run lint` installs `src` dependencies and runs ESLint against the TypeScript source.
- `npm run build` installs `src` dependencies,
  prepares production dependencies in `build/`,
  and compiles `src/handlers.ts` using the root `tsconfig.json`.
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

## Local Development

- `npm run local` builds the handlers and starts `sam local start-api`
  with disposable DynamoDB Local and S3Mock containers.
  It requires Docker and SAM; it does not deploy resources.
- `scripts/local-config.js` derives local routes and table schemas from `template.yaml`.
  Do not maintain a second route list or database schema.
- `scripts/local-proxy.js` supplies the Basic challenge and CORS headers SAM omits on gateway errors.
  Point browsers at the adapter (3001), not internal SAM (3002).
  Keep routing and authorization in SAM.
- SDK bootstrap requests need `throwOnRequestTimeout: true`;
  Smithy's `requestTimeout` otherwise only warns.
  Readiness checks must pass their deadline-linked signal to in-flight SDK requests.
- Local mocks require both `TOWER_LOCAL=true` and `AWS_SAM_LOCAL=true`.
  Keep arbitrary-password authentication and cloud-service mocks out of the deployment template.
  Never load deployment env/secrets files in the local launcher.
- `.devcontainer/docker/devcontainer.json` is the opt-in privileged DinD configuration.
  Keep DinD out of the standard devcontainer.
- `npm test` includes static local configuration and runtime-mock checks.
  Actual SAM/Docker networking, image transfers, and restart reset need the README smoke test.

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
- `.local/` (generated local SAM configuration)
- `node_modules/`
- `src/node_modules/`

Package-lock files are source files for reproducible installs.
Update the root lockfile with root dependency changes,
and update `src/package-lock.json` with Lambda dependency or test dependency changes.
