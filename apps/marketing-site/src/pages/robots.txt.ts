import type { APIRoute } from 'astro';
import { isProduction } from '../lib/site';

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const body = isProduction
    ? `User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${new URL('/sitemap.xml', site)}\n`
    : 'User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n';

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
