import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { Remote } from '../home/data.js';
import { RemoteView } from './RemoteView.js';

const children = () => createElement('p', null, 'Ready');

function renderRemote(remote: Remote<never>) {
  const props = { children, reload: vi.fn<() => void>(), remote };
  return renderToStaticMarkup(createElement(RemoteView, props));
}

describe('RemoteView retry feedback', () => {
  it('shows an explicit busy state while a retry is running', () => {
    const html = renderRemote({
      status: 'loading',
      retrying: true,
      message: 'Capability loading failed',
    });

    expect(html).toContain('Retrying…');
    expect(html).toContain('Trying to load the latest data…');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });

  it('distinguishes a failed retry from the initial failure', () => {
    const html = renderRemote({
      status: 'error',
      message: 'Capability loading failed',
      refreshFailure: true,
    });

    expect(html).toContain('Refresh failed');
    expect(html).toContain('Capability loading failed');
    expect(html).toContain('Try again');
  });
});
