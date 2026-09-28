import type { APIRoute } from 'astro';
import { guides } from '../lib/guides';
export const GET: APIRoute = ({ site }) =>
  new Response(
    `# Atlas documentation\n\nAtlas connects approved API actions into reviewed workflows. This is a developer preview: the customer web and company sign-in package is implemented, while full customer workflow-runtime packaging remains in development.\n\n${guides.map((guide) => `- [${guide.title}](${new URL(`/${guide.slug}/`, site)}): ${guide.description}`).join('\n')}\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
