# Atlas

Atlas is a personal project maintained by James Ashley. It detects API contract changes,
shows which workflows are affected, and runs reviewed integrations through Temporal.

This repository contains the application, local development tools, and documentation.
Start with this guide, the [technical resources](RESOURCES.md), or the
[developer course](apps/onboarding-site/README.md).

Docker Compose runs the Backend, per-environment ingest gateways, customer
Workers, mock services, PostgreSQL, and open-source Temporal with hosted and customer execution
boundaries kept as separate processes and networks. The Console intentionally runs outside Compose
with Vite hot module replacement.

For company sign-in, use the [standard customer web installation](docs/CUSTOMER_SSO_INSTALL.md)
in `infra/customer`. It runs the backend, PostgreSQL, and one reusable customer Console image
at a single HTTPS origin, with runtime Entra, Google Workspace, or Okta settings and approved
access requests. It does not use the demo Compose stack. Broader workflow runtime deployment
is still in development.
Customer mode supports Microsoft Entra ID, Google Workspace, or Okta through OpenID Connect,
with one provider per installation and protected sessions. The local demo setup below uses separate demo credentials.

## Sites

The Astro Marketing Site lives under [`apps/marketing-site`](./apps/marketing-site). Start it at
`http://localhost:4321` with:

```sh
vp run @atlas/marketing-site#dev
```

The Astro documentation site lives under [`apps/docs-site`](./apps/docs-site). Run `vp run @atlas/docs-site#dev`
to open it at `http://localhost:4322`. It includes core concepts, self-hosting, company sign-in,
and customer roles. Both public sites share their base styles and logo through `packages/site-ui`.

The Developer Course under [`apps/onboarding-site`](./apps/onboarding-site) explains local setup,
the four-application product architecture, every Console surface, and the main authoring, execution,
repair, and migration journeys in 13 short lessons. It is self-contained offline: open
`apps/onboarding-site/index.html` directly, or run its development server with:

```sh
vp run @atlas/onboarding-site#dev
```

The development server prints its URL when it starts. Run the sites locally or configure
separate deployments for this checkout.

See the [Marketing Site README](./apps/marketing-site/README.md),
[Documentation Site README](./apps/docs-site/README.md), and
[Developer Course README](./apps/onboarding-site/README.md) for their separate publishing rules.

The [customer self-hosting guide](./apps/docs-site/src/content/self-host.md) covers the current local evaluation and proposed Docker-based customer installation. It is served at `/self-host/` on the documentation site. The old marketing guide URLs redirect to the documentation site configured with `DOCS_SITE_ORIGIN`.

## Project state and workflow

Public GitHub repository ingestion and review are documented in
[GitHub repository contracts](docs/GITHUB_REPOSITORIES.md).

The application source and tests describe current behavior. Read the relevant guide under
`docs/` before changing a feature, and run the checks described below.

The demo runs locally. Docker Compose supplies Temporal and PostgreSQL; Vite serves the Console
and Hono's Node adapter serves the Atlas Backend.

## Static site hosting

The root [`wrangler.jsonc`](./wrangler.jsonc) is dedicated to the static course Worker and points at
`./apps/onboarding-site`. The Marketing Site has a separate
[`wrangler.jsonc`](./apps/marketing-site/wrangler.jsonc) that publishes its generated `dist/`
directory. The documentation site has its own [`wrangler.jsonc`](./apps/docs-site/wrangler.jsonc)
for its generated `dist/` directory. These configurations are separate from the locally run Atlas product MVP.

Cloudflare Workers Builds should watch `apps/onboarding-site/*` and `wrangler.jsonc` on `main`.
Build watch paths, branch control, and the course Access allowlist remain remote dashboard state.

To publish the checked-out course directly from the repository root:

```sh
npx wrangler deploy
```

This bypasses build watch paths and uploads the current checkout, so verify the branch first. The
Marketing Site has a separate production build and deployment procedure documented in its README.

## Repository layout

Current:

```text
.agents/skills/           vendored engineering skills
.scratch/                 cited prototypes and research notes
apps/                     product applications and independent static sites
apps/marketing-site/      Astro Marketing Site workspace and Worker configuration
apps/docs-site/           Astro public documentation and Worker configuration
apps/onboarding-site/     static Developer Course workspace
infra/compose/            local PostgreSQL, Temporal, Workers, Backend, ingest gateways, and mock services
packages/                 runtime-neutral shared packages
tooling/                  development, demo, dependency, and infrastructure tooling
AGENTS.md / CLAUDE.md     coding-agent instructions; kept identical
package.json              pinned pnpm/Vite+ workspace entry point
wrangler.jsonc            course-only Worker configuration
```

## Local development

Install these prerequisites:

- [Node.js 24.19.0](https://nodejs.org/en/download)
- [Docker Desktop](https://docs.docker.com/desktop/)

Then install pnpm:

```sh
npm install pnpm -g
```

This workspace pins pnpm 11.19.0 and Vite+ 0.2.6. Install the workspace dependencies, then run the
authoritative root validation commands:

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm check
vp test --run
vp run -w typecheck
vp run -r build
```

Start one shell for a specific workspace, for example the backend:

```sh
vp run @atlas/backend#dev
```

`pnpm dev --console-only` starts the Console directly with Vite HMR. The Console is intentionally absent
from Compose, so Docker cannot claim port 5173 or serve a stale frontend build.
The launcher prints the checkout it serves and refuses to run inside a container. Vite requires
port 5173; if another checkout already owns that port, stop its dev server before starting this
one. It will not silently choose a different port. HMR only watches the checkout that started
the server.

With the one-box product running, start the Console locally with Vite hot reload and recreate the
Compose backend and development ingest gateway in Hono/TypeScript watch mode. The other product
services remain unchanged:

```sh
pnpm dev
```

The Atlas Backend defaults to `http://localhost:4000`, the Console to
`http://localhost:5173`, the development ingest gateway to `http://localhost:4300`, the production
ingest gateway to `http://localhost:4301`, and the hosted-side demo source documents to
`http://localhost:4100`. Temporal UI is available at `http://localhost:8080` when the
infrastructure stack is running.

Burger Town is a separate demo app that is still being built. Atlas reserves
`http://localhost:43123` for it and reaches it from Compose as
`http://host.docker.internal:43123`. The Burger Town Connect Source form gets these editable
addresses from the Backend. Override the `ATLAS_BURGER_TOWN_*` values in `.env` if the delivered app
uses another address.

Copy [`.env.example`](./.env.example) to an ignored `.env` only when overriding safe local defaults.
It documents the database URL, Temporal endpoint/namespace/task queue, service URLs, ingest gateway
variables, and placeholder secret names. The product shells run without external credentials. For the one-box product, write
the model key to the ignored `.local/openai-api-key` file, then set
`OPENAI_API_KEY_FILE=../../.local/openai-api-key` and `OPENAI_MODEL` in the ignored root `.env` file.
Compose mounts the key as a backend-only secret, so it is absent from container metadata. The model
sees the typed intent and approved planner projection, but never execution credentials or execution
authority. Standard workflow execution remains available when the model is not configured. When
running the backend directly, use `OPENAI_API_KEY` and also configure
`ATLAS_PLANNING_AUTHOR_TOKEN` and `ATLAS_PLANNING_ORGANIZATION_ID` for one authorized organization.

## One-box product

Clear the local Atlas state, prepare an empty Burger Town demo, and leave it running with one
command:

```sh
pnpm prepare-demo
```

This removes the Compose-owned Atlas database and worker-secret volumes, then recreates the stack
with an empty capability catalog and no connected repositories. Add a public repository through
the Console when you are ready to inspect API contracts. It is safe to repeat when preparing a demo, but
it deliberately discards prior local Compose state. On success it prints the Console, backend, and
Temporal UI addresses; on failure it identifies the unhealthy preparation stage or service.

Build and start the backend, per-environment ingest gateways, per-environment outbound-only
workers, mock services, PostgreSQL, open-source Temporal, and Temporal UI without resetting saved
Atlas state:

```sh
pnpm infra:up
```

Compose never starts the Console. Run `pnpm dev --console-only` in a separate terminal for the Vite-served
UI with hot module replacement, or use `pnpm dev` to start Vite and the development backend path.

Startup merges the fixed demo fixture rows into the PostgreSQL-backed mock provider resource store.
It updates those named baseline rows without deleting other provider resources, so a payment seeded
by hand survives later `infra:up` calls. It also preserves saved workflows, approvals, runs,
provider idempotency/history, PostgreSQL data, and Temporal history. `infra:test:e2e` explicitly
replaces provider resources for its repeatable checks. `prepare-demo` discards the entire local
Atlas Compose state.
There is one upgrade exception: if startup finds the retired Production-like local stack, it
announces the transition and removes that disposable Atlas Compose project's containers,
PostgreSQL and Temporal volumes, and Worker-secret volumes before recreating Development and
Production. Exact retired Atlas resource names are also removed, including stopped or orphaned
resources; unrelated Docker resources, including other projects, containers, networks, and
volumes, are excluded. A surviving legacy database can trigger one guarded cleanup-and-retry. Once
the stack is canonical, later
`infra:up` calls preserve its durable state as normal.

Before pulling this rename, copy anything intentionally retained in those local demo volumes
outside the Atlas Compose project. Existing `.env` files must use
`ATLAS_EXECUTION_ENVIRONMENT_ID=production`; the retired `production-like` value is stale and is
rejected rather than silently mapped. Use `pnpm prepare-demo` whenever the entire local demo
should return to a clean baseline.

The Compose migration job applies the Atlas schema before the backend starts. The backend is at
`http://localhost:4000` and Temporal UI is at `http://localhost:8080`. Each environment exposes a
customer-side ingest gateway on the control network so callers can start Catalog workflows with
plaintext input: Development at `http://localhost:4300` and Production at `http://localhost:4301`.
The Development and Production Workers and customer mock services publish no host ports; each Worker
reaches the backend, Temporal, and mocks over separate Compose networks and polls the backend for
authenticated, customer-encrypted run commands; the hosted queue never stores plaintext business
input. Each Temporal payload codec key is generated at runtime in its own worker-mounted
config-file volume, and inbound HTTP intake is disabled in this topology. A separate hosted-side
mock-specs process keeps checked-in source documents available for infrastructure tests, but
ordinary local startup does not add their capabilities to the catalog. The local repair path crosses the customer
boundary only through a narrow gateway that accepts the guarded provider-condition repair
operation; it does not expose customer provider APIs to the hosted backend.
The gateway reads execution results from its environment worker at `ATLAS_INGEST_WORKER_URL`, authenticated with `ATLAS_WORKFLOW_RESULT_TOKEN` configured on both services. The worker reads encrypted Temporal results; response bodies are not stored in the backend database. This result-read endpoint remains available when inbound run intake is disabled. Existing executions started before this change have no final output and return `workflow-response-unavailable`; they are not rerun automatically. Capability responses currently use Atlas's JSON-object contract; downstream HTTP status codes and headers are not forwarded.

External systems start workflows through `POST /ingest` on the matching environment gateway. The request body includes `workflowName`, `payload`, and optional `idempotencyKey`. Organization and environment come from gateway configuration. Callers authenticate with the configured `ATLAS_INGEST_CALLER_TOKEN` bearer token. The gateway validates the payload against the active artifact input schema, encrypts to the worker run-command public key, fingerprints the plaintext, and queues through the backend. The request then waits for execution and returns `200` with the complete JSON object returned by the last capability, without an Atlas envelope. `X-Atlas-Command-Id` and `X-Atlas-Idempotency-Key` headers carry correlation metadata. A failed execution returns `502`; waiting longer than `ATLAS_INGEST_RESPONSE_TIMEOUT_MS` (default 60000) returns `504` with the command ID and idempotency key. Timeout or client disconnect does not cancel or repeat the workflow. Reusing the same idempotency key waits for the existing execution. `GET /ingest/:commandId` still reports worker acceptance and the run ID, not execution completion.
After a successful infra:up, POST JSON to the Development gateway at `http://localhost:4300/ingest` using the configured caller token. An example request body is:

```json
{
  "workflowName": "One-box smoke workflow",
  "payload": {
    "paymentId": "payment_demo_001"
  }
}
```

Send it with the configured caller bearer token to Development at `http://localhost:4300/ingest`. Use `http://localhost:4301/ingest` for Production. Read the generated caller token from your private `.env` file. No shared credentials are provided.

Authenticated webhook gateways submit an opaque, worker-encrypted payment payload to
`POST /v1/webhook-runs` with `organizationId`, `environmentId`, and a stable provider `deliveryId`.
It also sends a SHA-256 `payloadFingerprint`, which stays stable if the same payload is encrypted
again for redelivery. Atlas binds the first delivery to the exact active tested artifact and
worker; repeating the same delivery returns its existing command, while reusing its ID for a
different payload fingerprint returns `409`. The accepted artifact stays pinned even if another
version activates before polling. The customer worker decrypts and validates the payload against
that artifact's input schema before starting Temporal; validation failures are available from
run-command status as normalized, path-specific issues. The Runs page identifies webhook-originated
executions and their delivery IDs.

Stop the local infrastructure:

```sh
pnpm infra:down
```

Atlas reuses its dependency-install image layer across source-only changes. It automatically removes
dangling Atlas images after `infra:up` and `infra:test:e2e`; `prepare-demo` also removes build
cache older than 24 hours. This storage cleanup does not remove containers or named volumes, so
PostgreSQL and Worker keys remain intact during canonical ordinary startup. The one-time
Production-like transition described above is a separate, narrowly scoped cleanup. To run the safe
storage cleanup directly:

```sh
pnpm infra:clean:docker-cache
```

To include recent cache entries, run `pnpm infra:clean:docker-cache -- --include-recent`. Docker
build cache is shared across local projects, so their next build may take longer; containers,
images currently in use, and volumes are still preserved.

PostgreSQL is at `localhost:5432` and Temporal is at `localhost:7233`. Atlas uses the `atlas`
role/database. Temporal uses the separate `temporal` role with `temporal` and
`temporal_visibility` databases. Ordinary shutdown preserves the named `atlas-postgres-data`
volume. Build, verify both namespaces, the real topology, mock-spec access, and an approved
hash-checked run with encrypted Temporal history and worker-redacted traces, then stop its
containers without deleting that volume with:

```sh
pnpm infra:test:e2e
```

Access tokens and signing keys are generated by `pnpm setup:local`, never checked in. Compose
generates payload-encryption keys at runtime into separate customer-side worker-secret volumes.
Use independently managed credentials and customer authentication for any public deployment.

### Run input encryption upgrades

New browser and gateway submissions encrypt the JSON with a fresh AES-GCM key and wrap that
key with the worker's RSA public key (`rsa-aes-gcm:v1:`). This supports inputs larger than one
RSA block. Updated workers also read already-queued `rsa-oaep:` requests. When upgrading
services separately, upgrade workers before the Console and ingest gateways. The backend
accepts both formats and continues to store only encrypted input.

## Working on the course

Before editing a lesson, inspect the current implementation and the relevant authoritative decisions.
Keep `apps/onboarding-site/reference/glossary.html` terminology exact. Keep developer setup aligned with
root scripts and Compose, the architecture lesson aligned with all four applications, and the page
lessons aligned with every Console sidebar surface.

### Private local credentials

Run `pnpm setup:local` once before starting Atlas. It creates an ignored `.env` with random passwords, access tokens, and separate signing keys. It will not overwrite an existing file. Do not commit, upload, or share `.env`, `.local`, runtime logs, or database exports. Demo browser credentials are supplied only by `pnpm dev`; never deploy the demo role switcher publicly.

The local admin username is `admin`; its generated password is `ATLAS_DEMO_ADMIN_PASSWORD` in `.env`. Compose ports bind only to your computer. Existing database volumes retain their old passwords; back up your data and migrate credentials before reusing them with new configuration. Previously published demo credentials must not be reused.
