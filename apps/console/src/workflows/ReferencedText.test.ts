// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { ReferencedText } from './ReferencedText.js';

describe('ReferencedText', () => {
  it.each([false, true])(
    'shows a capability name on hover while preserving its lookup ID (catalog loaded=%s)',
    async (loaded) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const container = document.createElement('div');
      const root = createRoot(container);
      const capabilityVersionId = 'cap_opaque_67891';
      const text = 'createFulfillment';
      const onOpenCapability = vi.fn<(id: string) => void>();
      try {
        await act(async () =>
          root.render(
            createElement(ReferencedText, {
              text,
              annotations: [
                {
                  start: 0,
                  end: text.length,
                  text,
                  kind: 'capability',
                  capabilityVersionId,
                  evidence: {
                    projectionFingerprint: 'a'.repeat(64),
                    capabilityVersionId,
                    matchedTerms: ['createfulfillment'],
                  },
                },
              ],
              identities: loaded
                ? [
                    {
                      capabilityVersionId,
                      serviceId: 'fulfillment',
                      operationId: 'createFulfillment',
                    },
                  ]
                : [],
              onOpenCapability,
            }),
          ),
        );
        await act(async () =>
          container
            .querySelector('mark')
            ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
        );
        const details = container.querySelector('[role="dialog"]');
        expect(details?.textContent).toContain('createFulfillment');
        expect(details?.textContent).not.toContain(capabilityVersionId);
        expect(container.querySelector('mark')?.getAttribute('aria-label')).not.toContain(
          capabilityVersionId,
        );
        const open = [...container.querySelectorAll('button')].find(
          (button) => button.textContent === 'View capability',
        );
        expect(open).toBeDefined();
        await act(async () => open?.click());
        expect(onOpenCapability).toHaveBeenCalledWith(capabilityVersionId);
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );

  it('renders adjacent parts of the same qualified capability reference as one bubble', () => {
    const text = 'payments.getPayment returned a record.';
    const evidence = {
      projectionFingerprint: 'a'.repeat(64),
      capabilityVersionId: 'cap-payments',
      matchedTerms: ['payments', 'getpayment'],
    };

    const html = renderToStaticMarkup(
      createElement(ReferencedText, {
        annotations: [
          {
            start: 0,
            end: 'payments'.length,
            text: 'payments',
            kind: 'capability',
            capabilityVersionId: 'cap-payments',
            evidence,
          },
          {
            start: 'payments.'.length,
            end: 'payments.getPayment'.length,
            text: 'getPayment',
            kind: 'capability',
            capabilityVersionId: 'cap-payments',
            evidence,
          },
        ],
        identities: [
          {
            capabilityVersionId: 'cap-payments',
            serviceId: 'payments',
            operationId: 'getPayment',
            owner: 'payments-team',
          },
        ],
        onOpenCapability: () => undefined,
        text,
      }),
    );

    expect(html.match(/<mark/g)).toHaveLength(1);
    expect(html).toContain('>payments.getPayment</mark>');
  });

  it('announces a newly identified capability independently of its visual transition', () => {
    const text = 'Charge the card with createPayment.';
    const start = text.indexOf('createPayment');

    const html = renderToStaticMarkup(
      createElement(ReferencedText, {
        annotations: [
          {
            start,
            end: start + 'createPayment'.length,
            text: 'createPayment',
            kind: 'capability',
            capabilityVersionId: 'cap-payments',
            evidence: {
              projectionFingerprint: 'a'.repeat(64),
              capabilityVersionId: 'cap-payments',
              matchedTerms: ['createpayment'],
            },
          },
        ],
        identities: [
          {
            capabilityVersionId: 'cap-payments',
            serviceId: 'payments',
            operationId: 'createPayment',
            owner: 'payments-team',
          },
        ],
        onOpenCapability: () => undefined,
        text,
      }),
    );

    expect(html).toContain('aria-label="Capability: payments · createPayment"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('title=');
    expect(html).not.toContain('role="tooltip"');
  });

  it('announces a runtime input as a different kind of identified phrase', () => {
    const text = 'Use paymentId at runtime.';
    const start = text.indexOf('paymentId');

    const html = renderToStaticMarkup(
      createElement(ReferencedText, {
        annotations: [
          {
            start,
            end: start + 'paymentId'.length,
            text: 'paymentId',
            kind: 'runtimeInput',
            inputName: 'paymentId',
            evidence: {
              intentFingerprint: 'b'.repeat(64),
              source: 'intentFrame.requiredInputs',
            },
          },
        ],
        text,
      }),
    );

    expect(html).toContain('aria-label="Runtime input: paymentId"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('role="button"');
    expect(html).not.toContain('Open capability details');
  });
});
