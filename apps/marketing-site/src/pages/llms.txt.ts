import type { APIRoute } from 'astro';
import { docsUrl } from '../lib/site';
export const prerender = true;
export const GET: APIRoute = ({ site }) => {
  const body = `# Atlas

Atlas connects API knowledge to the workflows it powers. Teams can draft integrations from approved operations, validate and test them, approve exact versions, execute on Temporal, and review changes to connected contracts. Change analysis covers known Atlas-managed workflow dependencies after contract rediscovery.

Atlas is a personal project and developer preview. The customer web and company sign-in package is implemented; full customer workflow-runtime packaging remains in development. A broader maintained map of API capabilities and general agent access are future goals.

- [Overview](${new URL('/', site)}): Business outcomes, product illustration, use cases, and practical questions.
- [How it works](${new URL('/how-it-works/', site)}): Workflow lifecycle, Payment and Billing demo, and migration evaluation.
- [Compare approaches](${new URL('/compare/', site)}): Questions for comparing system knowledge, workflow tools, and maintenance responsibilities.
- [Evaluate Atlas](${new URL('/evaluate/', site)}): Fit, preparation checklist, and downloadable evaluation brief.
- [Documentation](${docsUrl()}): Core concepts and installation guides.
- [Self-hosting](${docsUrl('/self-host/')}): Developer workflow setup, customer web package, and runtime release requirements.
- [Company sign-in](${docsUrl('/sso-installation/')}): Installation, identity-provider configuration, and administrator access.
- [Customer roles](${docsUrl('/customer-roles/')}): Author, Operator, and Admin access rules.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
