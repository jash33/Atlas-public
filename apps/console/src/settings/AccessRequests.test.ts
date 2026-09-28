import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { EnrollmentPage } from '../shell/SignIn.js';
import { AccessRequestCard } from './AccessRequests.js';
import { decideAccessRequest } from './access-requests.js';

const pending = {
  id: 'request-123',
  displayName: 'Morgan',
  email: 'morgan@example.com',
  status: 'pending' as const,
};
afterEach(() => vi.unstubAllGlobals());

describe('access enrollment', () => {
  it('shows verified identity and a shareable reference without opening the product', () => {
    const html = renderToStaticMarkup(createElement(EnrollmentPage, { enrollment: pending }));
    expect(html).toContain('Waiting for access approval');
    expect(html).toContain('Morgan');
    expect(html).toContain('morgan@example.com');
    expect(html).toContain('request-123');
    expect(html).toContain('first admin');
    expect(html).toContain('Refresh status');
    expect(html).not.toContain('Sign in to Atlas');
  });
  it('requires a new provider sign-in after approval', () => {
    const html = renderToStaticMarkup(
      createElement(EnrollmentPage, { enrollment: { ...pending, status: 'approved' } }),
    );
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain('Sign in again');
  });
  it('explains rejection without offering product access', () => {
    const html = renderToStaticMarkup(
      createElement(EnrollmentPage, { enrollment: { ...pending, status: 'rejected' } }),
    );
    expect(html).toContain('Access request declined');
    expect(html).toContain('Contact your Atlas administrator');
    expect(html).not.toContain('Sign in to Atlas');
  });
  it('defaults approvals to author and only offers actions for pending requests', () => {
    const onDecision =
      vi.fn<(decision: 'approve' | 'reject', role: 'author' | 'operator' | 'admin') => void>();
    const html = renderToStaticMarkup(
      createElement(AccessRequestCard, { request: pending, onDecision }),
    );
    expect(html).toContain('Approve as author');
    expect(html).toContain('value="author" selected');
    expect(html).toContain('Reject request');
    const approved = renderToStaticMarkup(
      createElement(AccessRequestCard, { request: { ...pending, status: 'approved' }, onDecision }),
    );
    expect(approved).not.toContain('Approve as');
    expect(approved).not.toContain('Reject request');
  });
  it('submits explicit approval roles and sends no role for rejection', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await decideAccessRequest('request/123', 'approve', 'admin');
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/auth/access-requests/request%2F123/approve');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"role":"admin"}');
    await decideAccessRequest('request-123', 'reject');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });
});
