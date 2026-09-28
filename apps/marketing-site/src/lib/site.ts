import { SITE_ENV, DOCS_SITE_ORIGIN } from 'astro:env/server';

export const isProduction = SITE_ENV === 'production';

export const siteName = 'Atlas';

export const socialImagePath = '/social-preview.jpg';

export const docsUrl = (path = '/') => new URL(path, DOCS_SITE_ORIGIN).href;
