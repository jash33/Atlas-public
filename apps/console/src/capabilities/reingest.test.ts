import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { FailedReingestOutcome, presentFailedReingest } from './reingest.js';
import type { DiscoveryResult } from './data.js';

function result(
  overrides: Partial<DiscoveryResult> & Pick<DiscoveryResult, 'changes'>,
): DiscoveryResult {
  return {
    discoveryId: 'd-1',
    trigger: 'repository-push',
    capabilities: [
      { capabilityVersionId: 'cap-new', identity: identity(), lifecycleStatus: 'current' },
    ],
    ...overrides,
  };
}

function identity() {
  return {
    kind: 'openapi' as const,
    serviceId: 'billing',
    operationId: 'charge',
  };
}

describe('presentFailedReingest', () => {
  it('keeps the summary string when the update is compatible-only', () => {
    expect(
      presentFailedReingest(
        'billing',
        result({
          changes: [
            {
              fromCapabilityVersionId: 'cap-old',
              toCapabilityVersionId: 'cap-new',
              classification: 'compatible',
              affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
            },
          ],
        }),
      ),
    ).toEqual({
      tree: null,
      summary: '1 capability discovered · 1 change (1 compatible)',
    });
  });

  it('opens the blast-radius tree when rediscovery is not fully compatible', () => {
    const presented = presentFailedReingest(
      'billing',
      result({
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'breaking',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    );

    expect(presented.summary).toBe('1 capability discovered · 1 change (1 breaking)');
    expect(presented.tree).toEqual({
      serviceId: 'billing',
      coverage: 'unmapped',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-old',
          coverage: 'unmapped',
          workflowVersions: [
            { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['charge'] },
          ],
        },
      ],
    });
  });
});

describe('FailedReingestOutcome', () => {
  it('renders the shared tree instead of only a status string after a failed re-ingest', () => {
    const html = renderToStaticMarkup(
      createElement(FailedReingestOutcome, {
        serviceId: 'billing',
        environmentId: 'production',
        result: result({
          changes: [
            {
              fromCapabilityVersionId: 'cap-old',
              toCapabilityVersionId: 'cap-new',
              classification: 'conditional',
              affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
            },
          ],
        }),
      }),
    );

    expect(html).toContain('Source');
    expect(html).toContain('billing');
    expect(html).toContain('Capability version');
    expect(html).toContain('cap-old');
    expect(html).toContain('Workflow version');
    expect(html).toContain('pay@1');
    expect(html).toContain('Step');
    expect(html).toContain('charge');
    expect(html).toContain('sut-coverage-mapped');
    expect(html).toContain(
      '#/capabilities?view=map&amp;environmentId=production&amp;focusType=change&amp;focusId=d-1',
    );
    expect(html).toContain('View blast radius');
  });

  it('paints unmapped coverage on a breaking re-ingest tree', () => {
    const html = renderToStaticMarkup(
      createElement(FailedReingestOutcome, {
        serviceId: 'billing',
        environmentId: 'production',
        result: result({
          changes: [
            {
              fromCapabilityVersionId: 'cap-old',
              toCapabilityVersionId: 'cap-new',
              classification: 'breaking',
              fieldChanges: [
                { kind: 'removed', path: '/request/currency', classification: 'breaking' },
              ],
              affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
            },
          ],
        }),
      }),
    );

    expect(html).toContain('sut-coverage-unmapped');
    expect(html).toContain('cap-old');
    expect(html).toContain('pay@1');
  });

  it('paints potential coverage when rediscovery includes a verified hint', () => {
    const html = renderToStaticMarkup(
      createElement(FailedReingestOutcome, {
        serviceId: 'billing',
        environmentId: 'production',
        result: result({
          changes: [
            {
              fromCapabilityVersionId: 'cap-old',
              toCapabilityVersionId: 'cap-new',
              classification: 'breaking',
              fieldChanges: [
                { kind: 'removed', path: '/request/currency', classification: 'breaking' },
              ],
              affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
              potentialCoverage: { operationId: 'chargeV2', fieldPath: '/request/currencyCode' },
            },
          ],
        }),
      }),
    );

    expect(html).toContain('sut-coverage-potential');
    expect(html).not.toContain('sut-coverage-unmapped');
    expect(html).toContain('cap-old');
  });

  it('keeps a breaking re-ingest red when no verified hint is present', () => {
    const presented = presentFailedReingest(
      'billing',
      result({
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'breaking',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    );

    expect(presented.tree?.coverage).toBe('unmapped');
  });

  it('renders the current summary when the update is compatible-only', () => {
    const html = renderToStaticMarkup(
      createElement(FailedReingestOutcome, {
        serviceId: 'billing',
        environmentId: 'production',
        result: result({
          changes: [
            {
              fromCapabilityVersionId: 'cap-old',
              toCapabilityVersionId: 'cap-new',
              classification: 'compatible',
              affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
            },
          ],
        }),
      }),
    );

    expect(html).toContain('1 capability discovered · 1 change (1 compatible)');
    expect(html).not.toContain('Capability version');
    expect(html).not.toContain('Workflow version');
  });
});
