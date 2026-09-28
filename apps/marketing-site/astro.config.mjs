import { defineConfig, envField } from 'astro/config';
import { writeFile } from 'node:fs/promises';

const siteEnvironment = process.env.SITE_ENV ?? 'preview';
const configuredOrigin = process.env.SITE_ORIGIN;
const docsOrigin = process.env.DOCS_SITE_ORIGIN ?? 'http://localhost:4322';

if (siteEnvironment === 'production' && !configuredOrigin) {
  throw new Error('SITE_ORIGIN is required when SITE_ENV=production.');
}

if (siteEnvironment === 'production' && !process.env.DOCS_SITE_ORIGIN) {
  throw new Error('DOCS_SITE_ORIGIN is required when SITE_ENV=production.');
}
const docsUrl = new URL(docsOrigin);
if (
  !['http:', 'https:'].includes(docsUrl.protocol) ||
  (siteEnvironment === 'production' && docsUrl.protocol !== 'https:') ||
  docsUrl.pathname !== '/' ||
  docsUrl.search ||
  docsUrl.hash ||
  docsUrl.username ||
  docsUrl.password
) {
  throw new Error(
    'DOCS_SITE_ORIGIN must be an origin without a path or credentials, using HTTPS in production.',
  );
}
const movedPages = {
  '/docs': '/',
  '/self-host': '/self-host/',
  '/docs/sso-installation': '/sso-installation/',
  '/docs/customer-roles': '/customer-roles/',
  '/docs/sso-installation/customer-roles.md': '/customer-roles/',
};
const redirects = Object.fromEntries(
  Object.entries(movedPages).map(([from, to]) => [from, new URL(to, docsOrigin).href]),
);

export default defineConfig({
  output: 'static',
  devToolbar: { enabled: false },
  redirects,
  integrations: [
    {
      name: 'moved-documentation',
      hooks: {
        'astro:build:done': async ({ dir }) => {
          const rules = Object.entries(redirects).flatMap(([from, to]) => [
            `${from} ${to} 301`,
            ...(!from.endsWith('.md') ? [`${from}/ ${to} 301`] : []),
          ]);
          await writeFile(new URL('_redirects', dir), `${rules.join('\n')}\n`);
        },
      },
    },
  ],
  site: configuredOrigin ?? 'http://localhost:4321',
  env: {
    schema: {
      DOCS_SITE_ORIGIN: envField.string({
        context: 'server',
        access: 'public',
        default: docsOrigin,
      }),
      SITE_ENV: envField.enum({
        context: 'server',
        access: 'public',
        values: ['preview', 'production'],
        default: 'preview',
      }),
    },
  },
});
