import { describe, expect, it } from 'vite-plus/test';

import { plannerRecipeHints } from './capability-architecture.js';
import { createIntentCapabilityIndex } from './workflow-planning.js';

describe('createIntentCapabilityIndex', () => {
  it('includes operation summaries for matching a short request', () => {
    const index = createIntentCapabilityIndex({
      fingerprint: 'a'.repeat(64),
      capabilities: [
        {
          capabilityVersionId: 'checks.create@1',
          identity: { kind: 'openapi', serviceId: 'pos', operationId: 'createCheck' },
          fragment: {
            method: 'post',
            path: '/checks',
            operation: {
              operationId: 'createCheck',
              summary: 'Start a kitchen ticket',
              description: 'Open a check for the current order.',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['server_id'],
                      properties: { server_id: { type: 'string' } },
                    },
                  },
                },
              },
            },
            references: {},
          },
          annotation: {
            owner: 'pos-team',
            businessSemantics: { startsTicket: true },
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
          userAnnotations: ['Kitchen tickets are called chits by restaurant staff.'],
        },
      ],
    });

    expect(index.capabilities[0]).toMatchObject({
      capabilityVersionId: 'checks.create@1',
      summary: 'Start a kitchen ticket',
      description: 'Open a check for the current order.',
      userAnnotations: ['Kitchen tickets are called chits by restaurant staff.'],
    });
    expect(index.capabilities[0]).not.toHaveProperty('fragment');
  });
});

describe('plannerRecipeHints', () => {
  it('omits empty architecture and compactly lists connections', () => {
    expect(
      plannerRecipeHints({
        status: 'empty',
        title: '',
        sourceUrl: null,
        notices: ['none'],
        workflows: [],
        nodes: [],
        relationships: [],
      }),
    ).toBeUndefined();

    expect(
      plannerRecipeHints({
        status: 'ready',
        title: 'POS recipes',
        sourceUrl: 'https://pos.test/arazzo.yaml',
        notices: ['ignore me'],
        workflows: [{ workflowId: 'orderThenKitchen', summary: 'Order then kitchen' }],
        nodes: [],
        relationships: [
          {
            id: 'rel-1',
            kind: 'data-flow',
            workflowId: 'orderThenKitchen',
            workflowName: 'Order then kitchen',
            sourceOperationId: 'createCheck',
            targetOperationId: 'addItem',
            sourceStepId: 'createCheck',
            targetStepId: 'addItem',
            destinationField: 'check_id',
          },
        ],
      }),
    ).toEqual({
      title: 'POS recipes',
      workflows: [{ workflowId: 'orderThenKitchen', summary: 'Order then kitchen' }],
      connections: [
        {
          kind: 'data-flow',
          workflowId: 'orderThenKitchen',
          sourceOperationId: 'createCheck',
          targetOperationId: 'addItem',
          destinationField: 'check_id',
        },
      ],
    });
  });
});
