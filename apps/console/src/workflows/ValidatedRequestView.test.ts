import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { ValidatedRequestView } from './ValidatedRequestView.js';

describe('ValidatedRequestView', () => {
  it('shows both requests in reading order without hiding the original in a dropdown', () => {
    const html = renderToStaticMarkup(
      createElement(ValidatedRequestView, {
        annotations: [],
        clarifiedRequest: 'Read the payment with getPayment.',
        originalRequest: 'Read the payment.',
      }),
    );

    expect(html).toContain('Inferred request');
    expect(html).toContain('Original request');
    expect(html).toContain('Read the payment.');
    expect(html).toContain('Read the payment with getPayment.');
    expect(html.indexOf('aria-label="Original request"')).toBeLessThan(
      html.indexOf('aria-label="Inferred request"'),
    );
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).not.toContain('backend-verified mappings');
  });
});
