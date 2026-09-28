# Atlas developer course

This workspace is a static, offline-capable product and developer course. Open
`index.html` directly for offline use. Its `build` task copies the unchanged static artifact to
`dist/` so Vite+ can validate and orchestrate it as an independent monorepo unit.

## Sources of truth

- Current application code, package manifests, root scripts, and Compose topology own implemented
  behavior; the guides under `docs/` explain the supported features.
- `reference/glossary.html` owns exact Atlas terminology.
- `lessons/index.html` owns the product-oriented syllabus.

## Structure

```text
assets/       shared CSS, vendored Mermaid, and diagram lightbox
lessons/      13 short lessons and the authoritative course index
reference/    formal glossary and demo-workflow reference
index.html    redirect to the lesson index
```

All required content, local navigation, and assets work from disk; external source citations are
supplemental. Nothing load-bearing should exist only in a tooltip or hosted dependency.

## Publishing

The repository root `wrangler.jsonc` deploys this directory as the existing `atlas` static-assets
Worker. It is course-only; the MVP product runs locally and has no product Wrangler configuration.

Cloudflare Workers Builds must watch `apps/onboarding-site/*` and `wrangler.jsonc` on `main`. The
current course Access allowlist, build watch paths, and branch control are remote Cloudflare state.
`npx wrangler deploy` from the repository root publishes the current checkout directly.

## Maintenance checks

- Every factual claim traces to current implementation or an authoritative decision/specification.
- Developer setup matches root scripts, provider modes, and Compose behavior.
- Console lessons cover Home, Workflows, Capabilities, Runs, Changes, Activity, and Settings.
- The architecture lesson matches the four applications and current service interactions.
- The glossary stays synchronized with the Console, API, database, and runtime vocabulary.
- The existing course hostname and Access policy remain unrelated to the local product MVP.
