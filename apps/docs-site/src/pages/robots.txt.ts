import type { APIRoute } from 'astro';
import { SITE_ENV } from 'astro:env/server';
export const GET: APIRoute = ({ site }) =>
  new Response(
    SITE_ENV === 'production'
      ? `User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap.xml', site)}\n`
      : 'User-agent: *\nDisallow: /\n',
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
