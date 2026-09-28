import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { CapabilityMarquee } from './CapabilityMarquee.js';

const capabilities = [
  {
    capabilityVersionId: 'payments.get-payment@1',
    kind: 'openapi' as const,
    serviceId: 'payments',
    operationId: 'getPayment',
    owner: 'Payments',
  },
  {
    capabilityVersionId: 'billing.settle-invoice@1',
    kind: 'openapi' as const,
    serviceId: 'billing',
    operationId: 'settleInvoice',
    owner: 'Billing',
  },
  {
    capabilityVersionId: 'risk.check-payment@1',
    kind: 'openapi' as const,
    serviceId: 'risk',
    operationId: 'checkPayment',
    owner: 'Risk',
  },
  {
    capabilityVersionId: 'events.publish-payment@1',
    kind: 'asyncapi' as const,
    serviceId: 'events',
    operationId: 'publishPayment',
    owner: 'Events',
  },
];

describe('CapabilityMarquee', () => {
  it('presents available capabilities in two labelled rows with inspectable catalog-style cards', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMarquee, {
        capabilities,
        onOpenCapability: vi.fn<(capabilityVersionId: string) => void>(),
      }),
    );

    expect(html).toContain('aria-label="Available capabilities you can use in this workflow"');
    expect(html).toContain('aria-label="Available capabilities, row 1"');
    expect(html).toContain('aria-label="Available capabilities, row 2"');
    expect(html).toContain('getPayment');
    expect(html).toContain('settleInvoice');
    expect(html).toContain('checkPayment');
    expect(html).toContain('publishPayment');
    expect(html).toContain('aria-label="Open payments · getPayment capability details"');
    expect(html).toContain('class="cat-operation wf-capability-card"');
    expect(html).toContain('OpenAPI');
    expect(html).toContain('Annotated');
    expect(html).toContain('View details');
  });

  it('keeps the scrolling copies out of the accessibility tree', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityMarquee, {
        capabilities,
        onOpenCapability: vi.fn<(capabilityVersionId: string) => void>(),
      }),
    );

    expect(html.match(/<ul aria-hidden="true">/g)).toHaveLength(2);
    expect(html).not.toContain('Use these capabilities in your request');
  });

  it('renders nothing until the planner reference index is available', () => {
    expect(
      renderToStaticMarkup(
        createElement(CapabilityMarquee, {
          capabilities: [],
          onOpenCapability: vi.fn<(capabilityVersionId: string) => void>(),
        }),
      ),
    ).toBe('');
  });
});
