import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { SourceUpdateTreeView } from './SourceUpdateTreeView.js';
import type { SourceUpdateTree } from './tree.js';

const tree: SourceUpdateTree = {
  serviceId: 'billing',
  coverage: 'mapped',
  capabilityVersions: [
    {
      capabilityVersionId: 'cap-invoice-v3',
      coverage: 'mapped',
      workflowVersions: [
        {
          workflowVersionId: 'collect-payment@2',
          coverage: 'mapped',
          steps: ['authorize-charge', 'settle-invoice'],
        },
      ],
    },
  ],
};

describe('SourceUpdateTreeView', () => {
  it('names source, capability version, workflow version, and step as readable text', () => {
    const html = renderToStaticMarkup(createElement(SourceUpdateTreeView, { tree }));

    expect(html).toContain('Source');
    expect(html).toContain('billing');
    expect(html).toContain('Capability version');
    expect(html).toContain('cap-invoice-v3');
    expect(html).toContain('Workflow version');
    expect(html).toContain('collect-payment@2');
    expect(html).toContain('Step');
    expect(html).toContain('authorize-charge');
    expect(html).toContain('settle-invoice');
    expect(html).toContain('#/capabilities?capabilityVersionId=cap-invoice-v3');
    expect(html).toContain('#/workflows?workflowVersionId=collect-payment%402');
  });

  it('paints mapped nodes with a green coverage class and unmapped nodes with a red one', () => {
    const html = renderToStaticMarkup(
      createElement(SourceUpdateTreeView, {
        tree: {
          serviceId: 'billing',
          coverage: 'unmapped',
          capabilityVersions: [
            {
              capabilityVersionId: 'cap-mapped',
              coverage: 'mapped',
              workflowVersions: [
                {
                  workflowVersionId: 'refund@2',
                  coverage: 'mapped',
                  steps: ['credit'],
                },
              ],
            },
            {
              capabilityVersionId: 'cap-unmapped',
              coverage: 'unmapped',
              workflowVersions: [
                {
                  workflowVersionId: 'pay@1',
                  coverage: 'unmapped',
                  steps: ['charge'],
                },
              ],
            },
          ],
        },
      }),
    );

    expect(html).toContain('sut-source sut-coverage-unmapped');
    expect(html).toContain('sut-capability sut-coverage-mapped');
    expect(html).toContain('sut-workflow sut-coverage-mapped');
    expect(html).toContain('sut-step sut-coverage-mapped');
    expect(html).toContain('sut-capability sut-coverage-unmapped');
    expect(html).toContain('sut-workflow sut-coverage-unmapped');
    expect(html).toContain('sut-step sut-coverage-unmapped');
    expect(html).not.toContain('orange');
    expect(html).not.toContain('sut-coverage-potential');
  });

  it('paints potential nodes with an amber coverage class without recoding mapped or unmapped', () => {
    const html = renderToStaticMarkup(
      createElement(SourceUpdateTreeView, {
        tree: {
          serviceId: 'billing',
          coverage: 'potential',
          capabilityVersions: [
            {
              capabilityVersionId: 'cap-potential',
              coverage: 'potential',
              workflowVersions: [
                {
                  workflowVersionId: 'pay@1',
                  coverage: 'potential',
                  steps: ['charge'],
                },
              ],
            },
            {
              capabilityVersionId: 'cap-mapped',
              coverage: 'mapped',
              workflowVersions: [
                {
                  workflowVersionId: 'invoice@3',
                  coverage: 'mapped',
                  steps: ['issue'],
                },
              ],
            },
            {
              capabilityVersionId: 'cap-unmapped',
              coverage: 'unmapped',
              workflowVersions: [
                {
                  workflowVersionId: 'refund@2',
                  coverage: 'unmapped',
                  steps: ['credit'],
                },
              ],
            },
          ],
        },
      }),
    );

    expect(html).toContain('sut-source sut-coverage-potential');
    expect(html).toContain('sut-capability sut-coverage-potential');
    expect(html).toContain('sut-workflow sut-coverage-potential');
    expect(html).toContain('sut-step sut-coverage-potential');
    expect(html).toContain('sut-capability sut-coverage-mapped');
    expect(html).toContain('sut-workflow sut-coverage-mapped');
    expect(html).toContain('sut-capability sut-coverage-unmapped');
    expect(html).toContain('sut-workflow sut-coverage-unmapped');
  });
});
