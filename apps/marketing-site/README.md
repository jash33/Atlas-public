# Atlas Marketing Site.

Static public site for Atlas. It is independent of the Console, the Developer Course, and the root
course Worker.

Public documentation lives in [`apps/docs-site`](../docs-site/README.md). The former self-hosting, SSO, and customer-role pages redirect to the new site. Both sites share their base styles and Atlas logo through `@atlas/site-ui`.

```sh
pnpm --filter @atlas/marketing-site dev
pnpm --filter @atlas/marketing-site check
pnpm --filter @atlas/marketing-site build
```

Local and preview builds are `noindex` and disallow crawlers. A production build must set an explicit
canonical origin; it fails rather than publishing preview URLs as canonical:

```sh
SITE_ENV=production SITE_ORIGIN=https://your-domain.example DOCS_SITE_ORIGIN=https://docs.your-domain.example pnpm --filter @atlas/marketing-site build
```

The site-local `wrangler.jsonc` is an assets-only Cloudflare Worker configuration. When remote
publishing is intentionally set up, run the pinned external Wrangler version from this directory:

```sh
npx --yes wrangler@4.125.0 deploy
```

Domain selection, the Workers Builds project, DNS, and search-console registration remain launch
operations rather than repository defaults.

The public installation and evaluation guide lives in
[`apps/docs-site/src/content/self-host.md`](../docs-site/src/content/self-host.md).
Set `DOCS_SITE_ORIGIN` in the build environment so navigation and permanent redirects point to the deployed docs. Locally, it defaults to `http://localhost:4322`.
Keep its current developer commands aligned with the root README and Compose scripts.
The implemented customer web/sign-in package, planned full runtime package, and 30-minute onboarding target must stay clearly distinguished
until they have been shipped and verified. The site describes a personal project and links
to the source repository and setup documentation.


The homepage leads to `/compare/` and `/evaluate/`; the evaluation brief is generated in the browser and never submitted to a server. The workflow illustration is explicitly labeled as a demo, not a live Console session.
