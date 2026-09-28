import { describe, expect, it } from 'vite-plus/test';

import {
  inputSchemaFromCapabilityRequirements,
  resolveWorkflowInputSchema,
  withBackendOwnedInputs,
} from './workflow-input-schema.js';

const createCheck = {
  method: 'post',
  path: '/locations/{location_id}/checks',
  pathParameters: [{ name: 'location_id', in: 'path', required: true, schema: { type: 'string' } }],
  operation: {
    parameters: [{ name: 'dry_run', in: 'query', required: false, schema: { type: 'boolean' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['server_id', 'quantity', 'type', 'note'],
            properties: {
              server_id: { type: 'string', 'x-atlas-data-classification': 'internal' },
              quantity: { type: 'integer' },
              type: { type: 'string', const: 'pickup' },
              note: { type: 'string' },
              fulfillment_id: { type: 'string' },
            },
          },
        },
      },
    },
  },
  references: {},
};

const fragments = new Map<string, Record<string, unknown>>([['checks.create@1', createCheck]]);
const fragmentFor = (capabilityVersionId: string) => fragments.get(capabilityVersionId);

describe('workflow input schema', () => {
  it("turns a capability's required request fields into workflow inputs", () => {
    expect(inputSchemaFromCapabilityRequirements(createCheck)).toEqual({
      required: {
        location_id: { type: 'string' },
        server_id: { type: 'string', classification: 'internal' },
        quantity: { type: 'integer' },
        note: { type: 'string' },
      },
    });
  });

  it('skips fields the first step fixes and names inputs after what the step reads', () => {
    expect(
      inputSchemaFromCapabilityRequirements(createCheck, {
        location_id: { source: 'input', path: ['store'] },
        note: { source: 'literal', value: 'no onions' },
        server_id: { source: 'input', path: ['staff', 'id'] },
      }),
    ).toEqual({
      required: {
        store: { type: 'string' },
        server_id: { type: 'string', classification: 'internal' },
        quantity: { type: 'integer' },
      },
    });
  });

  it('does not treat a prior step output as a caller input', () => {
    expect(
      inputSchemaFromCapabilityRequirements(createCheck, {
        location_id: { source: 'stepOutput', stepId: 'open-order', path: ['id'] },
        server_id: { source: 'input', path: ['server_id'] },
        note: { source: 'literal', value: 'no onions' },
      }),
    ).toEqual({
      required: {
        server_id: { type: 'string', classification: 'internal' },
        quantity: { type: 'integer' },
      },
    });
  });

  it('prefers the inputs a workflow declares', () => {
    const schema = resolveWorkflowInputSchema(
      {
        inputSchema: { required: { order_id: { type: 'string' } } },
        steps: [{ kind: 'capabilityCall', capabilityVersionId: 'checks.create@1' }],
      },
      fragmentFor,
    );
    expect(schema).toEqual({ required: { order_id: { type: 'string' } } });
  });

  it('never lets the caller-facing schema carry the injected run id', () => {
    const schema = resolveWorkflowInputSchema(
      {
        inputSchema: {
          required: { order_id: { type: 'string' }, atlasWorkflowRunId: { type: 'string' } },
        },
        steps: [],
      },
      fragmentFor,
    );
    expect(schema).toEqual({ required: { order_id: { type: 'string' } } });
  });

  it('falls back to leftover required fields from every known step when nothing is declared', () => {
    for (const inputSchema of [
      undefined,
      { required: {} },
      { required: { atlasWorkflowRunId: { type: 'string' } } },
    ]) {
      expect(
        resolveWorkflowInputSchema(
          {
            inputSchema,
            steps: [
              { kind: 'terminal' },
              { kind: 'capabilityCall', capabilityVersionId: 'checks.create@1' },
              { kind: 'capabilityCall', capabilityVersionId: 'other@1' },
            ],
          },
          fragmentFor,
        ),
      ).toEqual(inputSchemaFromCapabilityRequirements(createCheck));
    }
  });

  it('collects leftover required fields from later steps, not only the first', () => {
    const sendOrder = {
      method: 'post',
      path: '/checks/{check_id}/send',
      pathParameters: [
        { name: 'check_id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      operation: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['item_id'],
                properties: { item_id: { type: 'string' } },
              },
            },
          },
        },
      },
      references: {},
    };
    expect(
      resolveWorkflowInputSchema(
        {
          steps: [
            {
              kind: 'capabilityCall',
              capabilityVersionId: 'checks.create@1',
              arguments: {
                location_id: { source: 'input', path: ['location_id'] },
                server_id: { source: 'input', path: ['server_id'] },
                note: { source: 'literal', value: 'no onions' },
              },
            },
            {
              kind: 'capabilityCall',
              capabilityVersionId: 'orders.send@1',
              arguments: {
                check_id: { source: 'stepOutput', stepId: 'create-check', path: ['id'] },
              },
            },
          ],
        },
        (capabilityVersionId) =>
          capabilityVersionId === 'orders.send@1' ? sendOrder : fragments.get(capabilityVersionId),
      ),
    ).toEqual({
      required: {
        location_id: { type: 'string' },
        server_id: { type: 'string', classification: 'internal' },
        quantity: { type: 'integer' },
        item_id: { type: 'string' },
      },
    });
  });

  it('declares no inputs when the first step is unknown', () => {
    expect(
      resolveWorkflowInputSchema(
        { steps: [{ kind: 'capabilityCall', capabilityVersionId: 'missing@1' }] },
        fragmentFor,
      ),
    ).toEqual({ required: {} });
  });

  it('adds the injected run id only where mappings and validation read inputs', () => {
    expect(withBackendOwnedInputs({ required: { order_id: { type: 'string' } } })).toEqual({
      required: {
        order_id: { type: 'string' },
        atlasWorkflowRunId: { type: 'string', classification: 'internal' },
      },
    });
  });
});
