# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project overview

This repository contains the AWS SAM backend for Tower.
Runtime Lambda code lives in `src/`,
project-level automation lives in `scripts/`,
and deployment infrastructure is defined in `template.yaml`.

The repository intentionally has two Node package manifests:

- The root `package.json` contains repository scripts and tooling used from the project root.
- `src/package.json` contains Lambda runtime dependencies,
  TypeScript,
  and the test command that compiles tests into `../build-test/test`.

Keep dependencies in the manifest that matches where they are used.
Do not move Lambda runtime or test dependencies to the root manifest unless the build layout is intentionally changed.

## Build and test

Run commands from the repository root unless a task explicitly says otherwise.

```sh
npm test
npm run build
```

`npm test` runs `scripts/test.js`,
which installs dependencies in `src/` and runs the Lambda test suite there.
`npm run build` runs `scripts/build.js`,
which installs Lambda dependencies and compiles `src/handlers.ts` into `build/`.

For documentation-only changes,
`git diff --check` is an acceptable minimal verification step.

## TypeScript conventions

Keep TypeScript changes consistent with the existing code:

- Use ES module syntax in `src/**/*.ts`.
- Keep relative imports extensionless unless `tsconfig.json` changes.
- Use 4-space indentation and semicolons,
  matching the existing source.
- Keep AWS SDK and Azure SDK calls explicit;
  avoid broad abstractions unless they remove repeated behavior.
- Prefer small helper functions in `src/helpers.ts` when behavior is reused or directly testable.
- Add or update `node:test` tests in `src/test/` for changed helper behavior.
- Preserve existing API response shapes and status codes unless the issue explicitly asks for an API change.

## JavaScript script conventions

Project scripts under `scripts/` and configuration modules under `config/` use CommonJS.
Keep them executable when they are entry points,
and prefer `spawnOrFail` from `scripts/lib.js` for shelling out so failures stop the workflow.

## Deployment safety

`npm run deploy` uses AWS CLI and SAM to create or update real AWS resources.
Do not run deployment commands unless the task explicitly requires deployment verification
and the target environment has been confirmed.

Never commit local environment files,
secrets,
AWS credentials,
Azure Communication Services access keys,
or generated deployment packages.
The tracked `.env`, `.env.development`, and `.env.production` files are defaults only;
local values belong in ignored `.env*.local` and `.secrets*` files.

## Generated files

Do not commit generated output directories:

- `build/`
- `build-test/`
- `node_modules/`
- `src/node_modules/`

If package manifests change,
update the corresponding lockfile in the same package directory.
