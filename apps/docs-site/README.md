# Atlas documentation

Public Astro documentation, separate from the marketing site and Developer Course.

```sh
vp run @atlas/docs-site#dev
pnpm --filter @atlas/docs-site check
pnpm --filter @atlas/docs-site build
```

Local docs run at `http://localhost:4322`; marketing runs at `http://localhost:4321`.
Start both apps to follow links between them. Both default to `noindex` outside production.

## Content and styles

- Add guides to `src/content/` as Markdown and register their title, description, and section in `src/lib/guides.ts`. Navigation, previous/next links, the sitemap, and `llms.txt` use that list.
- Company sign-in and roles render the existing `docs/CUSTOMER_SSO_INSTALL.md` and `docs/customer-roles.md` directly. Edit those originals to keep the repository and public guide in sync. The guide page replaces the SSO guide's repository-relative role link with its web destination when rendering.
- Self-hosting moved from the marketing site into `src/content/self-host.md`.
- Both sites use `@atlas/site-ui` for base typography, colors, the logo, buttons, and header rules. `src/styles/docs.css` adds the documentation layout.

## Production build

Set `SITE_ENV=production`, `SITE_ORIGIN` to the docs origin, and `MARKETING_SITE_ORIGIN` to the marketing origin in the build environment. Use HTTPS origins without paths. Production builds fail if either origin is missing. Do not ship localhost links.

Set `DOCS_SITE_ORIGIN` on the marketing build to the same docs origin. Old marketing URLs (`/self-host/`, `/docs/sso-installation/`, and `/docs/customer-roles/`) redirect there. Marketing emits HTML redirects for static hosts and an `_redirects` file for Cloudflare assets.

## Cloudflare hosting

Use [`wrangler.jsonc`](./wrangler.jsonc) for the separate `atlas-docs-site` Worker. It serves Astro's `dist/` output, keeps page URLs ending in `/`, and serves the generated 404 page for missing routes. Static Astro sites do not need the Cloudflare adapter or a Worker script; see [Cloudflare's Astro guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/).

The repository-root `wrangler.jsonc` belongs to the Developer Course. The docs site has its own configuration and deployment.

For a Cloudflare Workers Builds project connected to this monorepo, use these settings:

| Setting | Value |
| --- | --- |
| Worker name | `atlas-docs-site` |
| Root directory | Repository root (`/`) |
| Build command | `pnpm --filter @atlas/docs-site build` |
| Deploy command | `npx --yes wrangler@4.125.0 deploy --config apps/docs-site/wrangler.jsonc` |
| Production branch | `main` |

Add `SITE_ENV=production`, `SITE_ORIGIN`, and `MARKETING_SITE_ORIGIN` to **Settings > Build > Variables and secrets**, using the real docs and marketing HTTPS origins. These are build variables because Astro writes the links into static HTML; runtime Worker variables cannot change them. Use the Node and pnpm versions pinned in the root `package.json`.

Include these build watch paths so content and shared-style edits trigger a deployment:

```text
apps/docs-site/**
packages/site-ui/**
docs/CUSTOMER_SSO_INSTALL.md
docs/customer-roles.md
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
.node-version
```

The marketing site's build should also watch `packages/site-ui/**`. Set its `DOCS_SITE_ORIGIN` to the docs URL and rebuild marketing when that URL changes. Configure a custom docs domain in Cloudflare if needed, and use that same origin for `SITE_ORIGIN`. Build settings and domain setup are Cloudflare project settings; they are not controlled by this Wrangler file. See [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [monorepo setup](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/#monorepos).

For a manual deployment, set the same build variables in your shell, then run from the repository root:

```sh
pnpm --filter @atlas/docs-site build
npx --yes wrangler@4.125.0 deploy --config apps/docs-site/wrangler.jsonc
```
