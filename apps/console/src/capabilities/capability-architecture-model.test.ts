import { describe, expect, it } from 'vite-plus/test';
import type { CapabilityArchitecture } from '@atlas/workflow-ir';

import {
  architectureFitView,
  architecturePointFromScreen,
  architectureViewport,
  layoutCapabilityArchitecture,
} from './capability-architecture-model.js';

const architecture: CapabilityArchitecture = {
  status: 'ready',
  title: 'Burgertown workflows',
  sourceUrl: 'https://burger-town.test/arazzo.yaml',
  notices: ['These connections come from the provider Arazzo recipes.'],
  workflows: [
    { workflowId: 'payThenCharge', summary: 'Pay then charge' },
    { workflowId: 'orderThenKitchen', summary: 'C. Order then kitchen' },
  ],
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
    {
      operationId: 'createCheck',
      capabilityIdentityId: 'id-check',
      capabilityVersionId: 'v-check',
      serviceId: 'burger-town',
    },
    {
      operationId: 'addItem',
      capabilityIdentityId: 'id-add',
      capabilityVersionId: 'v-add',
      serviceId: 'burger-town',
    },
  ],
  relationships: [
    {
      id: 'rel-1',
      kind: 'execution-order',
      workflowId: 'payThenCharge',
      workflowName: 'Pay then charge',
      sourceOperationId: 'createPayment',
      targetOperationId: 'createCharge',
      sourceStepId: 'pay',
      targetStepId: 'charge',
    },
    {
      id: 'rel-2',
      kind: 'data-flow',
      workflowId: 'payThenCharge',
      workflowName: 'Pay then charge',
      sourceOperationId: 'createPayment',
      targetOperationId: 'createCharge',
      sourceStepId: 'pay',
      targetStepId: 'charge',
      destinationField: 'payment_id',
    },
    {
      id: 'rel-3',
      kind: 'data-flow',
      workflowId: 'orderThenKitchen',
      workflowName: 'C. Order then kitchen',
      sourceOperationId: 'createCheck',
      targetOperationId: 'addItem',
      sourceStepId: 'createCheck',
      targetStepId: 'addItem',
      destinationField: 'check_id',
    },
  ],
};

describe('capability architecture layout', () => {
  it('lays out one recipe from left to right', () => {
    const layout = layoutCapabilityArchitecture(architecture, 'payThenCharge');
    expect(layout.nodes.map((node) => node.operationId)).toEqual(['createPayment', 'createCharge']);
    expect(layout.nodes[0]!.y).toBe(layout.nodes[1]!.y);
    expect(layout.nodes[1]!.x).toBeGreaterThan(layout.nodes[0]!.x);
    expect(layout.relationships.map((relationship) => relationship.kind).sort()).toEqual([
      'data-flow',
      'execution-order',
    ]);
  });

  it('stacks every recipe when showing the full architecture', () => {
    const layout = layoutCapabilityArchitecture(architecture, 'all');
    expect(layout.nodes.map((node) => node.id)).toEqual([
      'payThenCharge:createPayment',
      'payThenCharge:createCharge',
      'orderThenKitchen:createCheck',
      'orderThenKitchen:addItem',
    ]);
    expect(layout.nodes[2]!.y).toBeGreaterThan(layout.nodes[0]!.y);
    expect(layout.relationships).toHaveLength(3);
  });

  it('fits a wide recipe into the architecture viewport', () => {
    expect(architectureFitView({ width: 2800, height: 640 })).toEqual({
      zoom: 0.5,
      x: 0,
      y: 160,
    });
  });

  it('maps a screen point onto the architecture viewport', () => {
    expect(
      architecturePointFromScreen(
        {
          left: 0,
          top: 0,
          width: architectureViewport.width / 2,
          height: architectureViewport.height / 2,
        },
        { x: 100, y: 40 },
      ),
    ).toEqual({ x: 200, y: 80 });
  });
});
