import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import type { CapabilityArchitecture } from '@atlas/workflow-ir';

import {
  architectureRecipeFromHash,
  capabilityArchitectureHash,
  CapabilityArchitectureView,
} from './CapabilityArchitecture.js';

const architecture: CapabilityArchitecture = {
  status: 'ready',
  title: 'Burgertown workflows',
  sourceUrl: 'https://burger-town.test/arazzo.yaml',
  notices: [
    'These connections come from the provider Arazzo recipes. They are not Atlas blast radius.',
  ],
  workflows: [{ workflowId: 'payThenCharge', summary: 'Pay then charge' }],
  nodes: [
    {
      operationId: 'createPayment',
      capabilityIdentityId: 'id-pay',
      capabilityVersionId: 'v-pay',
      serviceId: 'burger-town',
    },
    {
      operationId: 'createCharge',
      capabilityIdentityId: 'id-charge',
      capabilityVersionId: 'v-charge',
      serviceId: 'burger-town',
    },
  ],
  relationships: [
    {
      id: 'rel-1',
      kind: 'data-flow',
      workflowId: 'payThenCharge',
      workflowName: 'Pay then charge',
      sourceOperationId: 'createPayment',
      targetOperationId: 'createCharge',
      sourceStepId: 'pay',
      targetStepId: 'charge',
      destinationField: 'payment_id',
    },
  ],
};

describe('Capability architecture view', () => {
  it('shares Architecture links with an optional recipe', () => {
    expect(architectureRecipeFromHash('#/capabilities?view=architecture')).toBe('all');
    expect(
      architectureRecipeFromHash('#/capabilities?view=architecture&recipe=payThenCharge'),
    ).toBe('payThenCharge');
    expect(capabilityArchitectureHash('development', 'all')).toBe(
      '#/capabilities?view=architecture&environmentId=development',
    );
  });

  it('draws declared operations and says they are not blast radius', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityArchitectureView, {
        architecture,
        environmentId: 'development',
        recipe: 'all',
      }),
    );
    expect(html).toContain('createPayment');
    expect(html).toContain('createCharge');
    expect(html).toContain('Pay then charge');
    expect(html).toContain('not Atlas blast radius');
  });

  it('exposes a pannable canvas with zoom controls', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityArchitectureView, {
        architecture,
        environmentId: 'development',
        recipe: 'all',
      }),
    );
    expect(html).toContain('Pan and zoom provider architecture');
    expect(html).toContain('Drag to pan · scroll to zoom');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('Reset architecture to fit');
    expect(html).toContain('viewBox="0 0 1400 640"');
    expect(html).toContain('scale(');
  });

  it('explains an empty environment', () => {
    const html = renderToStaticMarkup(
      createElement(CapabilityArchitectureView, {
        architecture: {
          status: 'empty',
          title: '',
          sourceUrl: null,
          notices: ['No provider recipes are stored for this environment.'],
          workflows: [],
          nodes: [],
          relationships: [],
        },
        environmentId: 'development',
        recipe: 'all',
      }),
    );
    expect(html).toContain('No provider recipes are stored');
    expect(html).toContain('Arazzo recipes');
  });
});
