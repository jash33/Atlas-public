import type { APIRoute } from 'astro';
import { guides } from '../lib/guides';
export const GET: APIRoute = ({ site }) => {
  const paths = ['/', ...guides.map((guide) => `/${guide.slug}/`)];
  const entries = paths.map((path) => `<url><loc>${new URL(path, site)}</loc></url>`).join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`,
    { headers: { 'Content-Type': 'application/xml; charset=utf-8' } },
  );
};
