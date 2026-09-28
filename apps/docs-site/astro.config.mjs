import { defineConfig, envField } from 'astro/config';

const production = process.env.SITE_ENV === 'production';
const origin = process.env.SITE_ORIGIN;
const marketingOrigin = process.env.MARKETING_SITE_ORIGIN;

for (const [name, value] of Object.entries({
  SITE_ORIGIN: origin,
  MARKETING_SITE_ORIGIN: marketingOrigin,
})) {
  if (production && !value) throw new Error(`${name} is required when SITE_ENV=production.`);
  if (value) {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      (production && url.protocol !== 'https:') ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error(
        `${name} must be an origin${production ? ' using HTTPS' : ''}, without a path or credentials.`,
      );
    }
  }
}

export default defineConfig({
  output: 'static',
  site: origin ?? 'http://localhost:4322',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  markdown: { shikiConfig: { theme: 'github-light' } },
  env: {
    schema: {
      SITE_ENV: envField.enum({
        context: 'server',
        access: 'public',
        values: ['preview', 'production'],
        default: 'preview',
      }),
      MARKETING_SITE_ORIGIN: envField.string({
        context: 'server',
        access: 'public',
        default: marketingOrigin ?? 'http://localhost:4321',
      }),
    },
  },
});
