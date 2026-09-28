# Mock service estate

Issue #21's Payment, Billing, domain-event, and Operations Notification surfaces run together as
one independently buildable local process:

```powershell
pnpm.cmd --filter @atlas/mock-services dev
```

The process listens on `MOCK_SERVICES_PORT` (default `4100`). It publishes its baseline contracts
at `/specs/payment.openapi.json`, `/specs/billing.openapi.json`,
`/specs/operations.openapi.json`, and `/specs/events.asyncapi.json`. The same generated documents
are committed under `specs/`; `pnpm --filter @atlas/mock-services specs:check` fails when they
drift from the runtime Zod contracts. Commit-ready Billing variants for every supported mutation
live under `specs/mutations/`, so a repository push can exercise rediscovery.

## Provider state

All resource-shaped state lives in one workflow-agnostic `ProviderResourceStore`
(`src/provider-resource-store.ts`). The store does not know what a payment or an invoice is: every
resource is a JSON document addressed by `(providerId, serviceId, collection, resourceId)` with a
version, alongside one provider-wide idempotency ledger and a service-tagged operation history.
Payments are read from `('payments', 'payments', paymentId)`; invoices from
`('billing', 'invoices', invoiceId)`. Billing's `expectedInvoiceVersion` optimistic-concurrency and
status-transition rules live in `src/billing.ts` and are expressed through the store's generic
`mutate`. Because Billing and Operations Notification share the same ledger, an idempotency key
used by one operation is replayed by every other, as #21 requires.

Set `MOCK_PROVIDER_DATABASE_URL` and the required `MOCK_PROVIDER_ID` to persist that state in
PostgreSQL (tables `mock_provider_resources`, `mock_provider_idempotency`, and
`mock_provider_operation_history`) so payments, invoices, ledger entries, and history survive a
`mock-services` restart and ordinary `pnpm infra:up`. Normal startup merges the named demo fixtures,
so unrelated resources seeded by a developer remain in place. On start the PostgreSQL store also drops
the pre-#175 `mock_billing_*` tables if they exist; their rows were demo fixtures reset on every
Compose start, so nothing is migrated and the drop is safe to repeat. The provider ID is an
isolation boundary: state resets delete only that provider's rows, so independently deployed
providers and parallel test runs must use distinct values. Compose assigns separate IDs to
`mock-services` and `mock-specs`; without these variables, an app created for unit tests uses
isolated in-memory state.

The following remain ephemeral scenario state and reset with the process on purpose: fault plans,
the deterministic retry counter for `payment_retry_demo_001`, provider-condition repairs,
published-event and notification observations, mapping-demo requests, and the Stripe, Slack, and
HubSpot rehearsal records.

Adding a mock service means adding its route handlers in `src/app.ts` and its contract in
`src/contracts.ts` / `src/documents.ts`. To seed a fixture, add one
`{service, collection, id, document}` row to `tooling/demo-provider-baseline.mjs`; there is no
service-specific seed schema or storage change.

`/specs/stripe.openapi.json` and `POST /v1/payment_intents` provide a deterministic,
contract-faithful rehearsal subset of Stripe's public OpenAPI contract. This local fallback is
deliberately labeled and does not represent live Stripe connectivity; configure a Stripe test-mode
secret reference and set `STRIPE_DEMO_MODE=official-test` to approve `api.stripe.com` for the
representative operation. The rehearsal subset records the exact upstream Stripe revision and path
used as contract evidence.

`/specs/slack.openapi.json` and `POST /api/chat.postMessage` provide the same governed path for
Slack notifications. The default is a clearly labeled, contract-faithful local rehearsal based on
Slack's pinned API-spec repository. Set `SLACK_DEMO_MODE=official-test` and provide a
`SLACK_BOT_TOKEN` secret reference to route the operation to a configured Slack test workspace.
The served specification contains the reference name only; the credential stays in the worker.

`/specs/hubspot.openapi.json` and `POST /crm/v3/objects/contacts` provide the governed CRM path.
The default is a clearly labeled, contract-faithful local rehearsal based on HubSpot's pinned public
API specification. Set `HUBSPOT_DEMO_MODE=official-test` and provide a
`HUBSPOT_ACCESS_TOKEN` secret reference to route the operation to a configured HubSpot developer
test account. The credential stays in the worker and is never included in the served contract.

`PUT /__control/resources` accepts
`{mode: 'replace' | 'merge', resources: [{service, collection, id, document}]}`. `merge` upserts
only those rows and is used by ordinary `infra:up`. `replace` clears this provider's resources,
idempotency entries, operation history, faults, and ephemeral observations before seeding; the
explicit `infra:test:e2e` path uses it. `GET /__control/resources` lists the
rows and accepts optional `service` and `collection` filters. `PUT /__control/faults` selects a
transient, permanent, schema-violating, stale-version, or cleared fault for one operation. `PUT
/__control/specs/billing` selects the baseline or one of four drift fixtures. `GET
/__control/observations` exposes published events, notifications, and global idempotency keys for
acceptance assertions.

These control routes are local demonstration controls, not Atlas product endpoints.
