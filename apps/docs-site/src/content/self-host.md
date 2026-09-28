# Run Atlas in your infrastructure.

**Developer preview · September 2026.** Two paths are implemented: a local developer stack for workflow evaluation, and a customer web package for the Console and company sign-in. The complete customer workflow runtime package and release checks are still in development.

For the customer web package, use the [company sign-in installation guide](/sso-installation/). It covers the prebuilt Console, backend, PostgreSQL, and HTTPS setup, with one identity provider per installation. That package does not deploy Temporal or customer Workers. Source is available in the [Atlas repository](https://github.com/jash33/Atlas-public).

[Current local setup](#try-the-current-local-build) · [Planned installation](#planned-customer-runtime-installation) · [Operations](#operating-your-installation) · [Release checklist](#before-customer-release)

## The first-run target: 30 minutes

With Docker installed and a release downloaded, the setup target is a healthy installation and one successful sample workflow within 30 minutes. This is a design target, not a measured setup time or a production-readiness promise.

| Time budget   | Intended outcome                                          |
| ------------- | --------------------------------------------------------- |
| 0–5 minutes   | Check prerequisites and configure the environment.        |
| 5–15 minutes  | Start containers and initialize storage.                  |
| 15–20 minutes | Open the Console and register the first worker.           |
| 20–30 minutes | Run a sample, repeat its request, and inspect the result. |

## What you will run

The customer web package uses Docker Compose on a supported Linux host. The full workflow execution deployment also needs the components below. Production sizing, availability, and release requirements still need validation.

| Component      | Responsibility                                                               | Data to retain                                                   |
| -------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Console        | Review workflows and inspect runs in a browser.                              | Configuration; application records live in the Backend database. |
| Backend        | Store API definitions, workflow versions, approvals, and run metadata.       | Atlas PostgreSQL database and signing keys.                      |
| Ingest gateway | Authenticate requests and submit encrypted work to the matching environment. | Authentication and environment configuration.                    |
| Worker         | Execute approved steps and reach your APIs.                                  | Worker credentials and encryption keys.                          |
| Temporal       | Preserve workflow execution history and coordinate recovery.                 | Temporal databases and configuration.                            |
| PostgreSQL     | Store Atlas and Temporal records in separate databases.                      | Database backups.                                                |

The current local stack runs these boundaries as separate processes and networks. The customer web package covers the Console, Backend, PostgreSQL, and HTTPS. Adding the full execution services requires the broader runtime deployment work. An external planning model, if enabled, receives intent and approved API information; self-hosting alone does not mean all processing is offline.

## Try the current local build

This path runs Atlas from a source checkout. It uses demo credentials and local mock APIs. Keep it on a development machine with restricted network access: several service ports are published on the host. The environment named `production` is part of the local demo, not a hardened deployment.

### 1. Prepare your machine

Use the versions pinned in the repository: Node.js **24.19.0**, pnpm **11.19.0**, and Docker with the Compose plugin. Confirm Docker is running:

```sh
node --version
pnpm --version
docker version
docker compose version
```

Clone [Atlas-public](https://github.com/jash33/Atlas-public), then run the following commands from its root.

### 2. Install dependencies and start services

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm infra:config
pnpm infra:up
```

Startup builds the application images, applies database migrations, creates the Temporal namespaces, and prepares demo API definitions. First builds depend on download speed and machine resources.

**Existing demo installations:** `infra:up` includes a migration from the retired `production-like` setup that can remove old local Atlas volumes. Export anything you need before upgrading that older setup. Ordinary startup on the current topology retains data. Do not use `prepare-demo` on data you want to keep.

### 3. Start the Console

In another terminal, from the repository root:

```sh
pnpm dev --console-only
```

Open **http://localhost:5173**. This local evaluation uses the development Console. The separate customer web package already provides a prebuilt, container-served Console; see the [company sign-in guide](/sso-installation/).

### 4. Verify the installation

```sh
docker compose -f infra/compose/compose.yaml ps
curl http://localhost:4000/health
curl http://localhost:4300/health
curl http://localhost:4301/health
```

Use `curl.exe` instead of `curl` in Windows PowerShell if `curl` resolves to a PowerShell alias. The Backend and both ingest health checks should return a successful HTTP response. Migration and namespace setup containers are expected to exit successfully rather than stay running. Open **http://localhost:8080** to inspect Temporal.

In the Console, select Development, confirm the worker is connected, and review the sample workflow available in the catalog. Activate only a tested, approved workflow. Submit test input through the Development gateway at port **4300**, using the workflow's exact name and input schema. The current demo caller token is `local-ingest-caller-token`.

For a Payment sample that accepts `paymentId`, this is the request shape; replace the workflow name with the one you reviewed:

```http
POST /ingest HTTP/1.1
Host: localhost:4300
Authorization: Bearer local-ingest-caller-token
Content-Type: application/json

{
  "workflowName": "REPLACE_WITH_APPROVED_WORKFLOW_NAME",
  "payload": { "paymentId": "payment_demo_001" },
  "idempotencyKey": "first-evaluation-001"
}
```

Expect HTTP `200` with the final step's JSON result for a successful completed run. Inspect the run in the Console. Repeat the exact request with the same idempotency key and verify it refers to the existing execution. A gateway timeout (`504`) does not cancel the workflow; keep the same key when waiting again. Provider writes also need their own reviewed duplicate-handling rules.

Standard execution does not require a planning-model key. To evaluate AI drafting, follow the repository README's backend-only secret-file setup and choose the model there. Do not put execution credentials into prompts.

### 5. Stop without deleting your data

Stop the Console with Ctrl+C, then:

```sh
pnpm infra:down
```

Named database and worker-secret volumes remain. Avoid `docker compose down -v` and `pnpm prepare-demo` unless you intend to discard the local demo state and keys.

### If setup fails

- **Docker cannot connect:** start Docker and repeat `docker version`.
- **A port is already in use:** check 4000, 4100, 4300, 4301, 5173, 5432, 7233, and 8080 before starting again.
- **Network overlap:** the local Compose file reserves `172.30.99.0/24` and `172.30.100.0/24`. Check for collisions with VPN or Docker networks; its fixed addresses must be changed consistently.
- **A service is unhealthy:** run `docker compose -f infra/compose/compose.yaml logs --tail 100 backend atlas-migrate temporal worker-development ingest-development`. Resolve the first failing dependency before restarting. Remove secrets and business data before sharing logs.
- **The Console cannot reach Atlas:** confirm the Backend health check works and that the Console's API URL matches the local Backend.
- **A run times out:** inspect the existing run and worker status before resubmitting. Reuse the original idempotency key; do not create another write just to test connectivity.

## Planned customer runtime installation

**The steps below describe the complete workflow-runtime release still being prepared. They are not commands for an available full-runtime installer.** The web and sign-in package is documented separately and already has its own setup commands.

### 1. Obtain a versioned release

A complete runtime release needs a Compose file, pinned image digests, an environment template, release notes, and checksums. The web package already supplies a built Console. The full runtime release must also provide execution services without mock dependencies or seeded customer records. Supported hosts and minimum CPU, memory, and disk requirements remain to be defined and tested.

### 2. Configure access and storage

Choose the Console hostname, certificate setup, API destinations, and backup location. Supply unique database passwords, signing keys, worker credentials, and per-environment encryption keys using mounted secrets or an approved secret store. The installer must create a customer organization and first administrator without the demo's shared tokens.

Keep PostgreSQL, Temporal, and worker control endpoints on private networks. Expose the Console and required application routes through authenticated HTTPS. Restrict ingest to approved callers and restrict worker access to intended API destinations. Development and production need separate credentials, keys, and execution settings.

### 3. Initialize and start

The release should validate configuration, initialize Atlas and Temporal storage, create namespaces, run migrations once, and start healthy services in order. A preflight check must catch missing secrets, storage permissions, port conflicts, and unsupported versions before accepting traffic.

The exact start command will be documented with the shipped bundle. Do not repurpose the repository's demo Compose file as a production installer.

### 4. Prove the first workflow

Sign in, register the worker, and run an isolated sample against test APIs. Acceptance should cover successful completion, duplicate delivery, a provider timeout, and worker restart during a run. Confirm that recovery does not repeat completed side effects unexpectedly, that the approved version stays fixed, and that run history is visible.

Then connect one customer API, approve the allowed operations, and test a small workflow using non-production credentials. Introduce production traffic only after the operator has verified access controls, backups, recovery, and the relevant provider behavior.

## Operating your installation

### Backups and recovery

Back up the Atlas database, both Temporal databases, configuration, signing keys, and worker encryption keys under a documented recovery procedure. Database backups alone cannot recover encrypted workflow data if the keys are lost. Keep old decryption keys for as long as retained histories need them. Store backup copies outside the application host, restrict access, and rehearse restoration into an isolated environment before accepting production traffic.

Recovery targets, backup frequency, retention, and a tested restore command sequence must be included in the customer release documentation. A single Compose host does not provide high availability.

### Upgrades and rollback

Read release notes, take verified backups, and test the new release with representative workflows in a separate environment. Check compatibility with in-flight Temporal executions before changing workers. Schedule database migrations and decide whether intake needs to pause. Preserve the previous image versions and configuration.

An older image may not work with a newer database schema. Rollback must follow a tested release-specific procedure, including database recovery where required; do not assume changing an image tag is enough.

### Health and support

Monitor service health, worker availability, queued work, failed runs, database capacity, disk space, and backup age. Define who handles a failed integration and how to escalate it. A diagnostic bundle should include version numbers, service status, and redacted logs. This project does not provide a production support commitment.

## Before customer release

- Complete the versioned customer runtime bundle and release checks, building on the existing web and sign-in package.
- Remove demo defaults, mock dependencies, and automatic legacy-volume cleanup.
- Validate existing company sign-in and administrator onboarding together with execution-key generation and rotation.
- Validate host requirements, network restrictions, HTTPS, and secret handling.
- Ship a sample workflow and an automated first-run verification command.
- Rehearse backup, restore, upgrade, and rollback with in-flight workflows.
- Measure the 30-minute onboarding target on a clean supported machine.
- Document release access, operating responsibilities, and production availability limits.

[See how Atlas workflows work](/concepts/workflows/) · [Back to documentation](/)

## Deployment references

The proposed package follows Docker's separation of development and production configuration; see [Docker's Compose production guide](https://docs.docker.com/compose/how-tos/production/). Temporal operations also require explicit security, monitoring, and upgrade procedures; see the [Temporal self-hosting guide](https://docs.temporal.io/self-hosted-guide).
