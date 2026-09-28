import { describe, expect, it, vi } from 'vite-plus/test';
import { readWorkflowInvocationExample } from './workflow-invocation-example.js';

const executable = {
  inputSchema: {
    required: {
      location_id: { type: 'string' },
      quantity: { type: 'integer' },
      order_id: { type: 'string' },
    },
  },
  steps: [
    {
      kind: 'capabilityCall',
      capabilityVersionId: 'cap-a',
      arguments: { location_id: { source: 'input', path: ['location_id'] } },
      idempotency: { businessKey: { source: 'input', path: ['order_id'] } },
    },
  ],
};
const row = {
  executable,
  capability_version_id: 'cap-a',
  inputs: {
    location_id: 'loc_oak',
    quantity: 1,
    order_id: 'sandbox-order',
    unused: 'do-not-expose',
  },
};
const scope = {
  organizationId: 'org_atlas',
  environmentId: 'development',
  workflowVersionId: 'active-version',
};

describe('workflow invocation examples', () => {
  it('uses connected, tested inputs and generates a fresh idempotency-only business key', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
    const first = await readWorkflowInvocationExample(pool, scope);
    const second = await readWorkflowInvocationExample(pool, scope);
    expect(first).toEqual({ location_id: 'loc_oak', quantity: 1, order_id: expect.any(String) });
    expect(first?.order_id).not.toBe('sandbox-order');
    expect(first?.order_id).not.toBe(second?.order_id);
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['org_atlas', 'development', 'active-version']);
  });

  it('never exports non-production fixtures to production', async () => {
    const pool = { query: vi.fn() };
    expect(
      await readWorkflowInvocationExample(pool, { ...scope, environmentId: 'production' }),
    ).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ ...row, inputs: { order_id: 'sandbox-order', quantity: 1 } }],
    [{ ...row, inputs: { ...row.inputs, quantity: 'one' } }],
    [{ ...row, capability_version_id: 'wrong-capability' }],
  ])('fails closed when tested data is missing, invalid, or incomplete', async (...rows) => {
    const pool = { query: vi.fn().mockResolvedValue({ rows }) };
    expect(await readWorkflowInvocationExample(pool, scope)).toBeNull();
  });

  it('does not invent values for renamed workflow inputs', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            ...row,
            executable: {
              ...executable,
              inputSchema: { required: { locationId: { type: 'string' } } },
            },
          },
        ],
      }),
    };
    expect(await readWorkflowInvocationExample(pool, scope)).toBeNull();
  });

  it('preserves a business key that is also a provider lookup argument', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            ...row,
            executable: {
              ...executable,
              steps: [
                {
                  ...executable.steps[0],
                  arguments: { order: { source: 'input', path: ['order_id'] } },
                },
              ],
            },
          },
        ],
      }),
    };
    expect((await readWorkflowInvocationExample(pool, scope))?.order_id).toBe('sandbox-order');
  });
});
