// @vitest-environment happy-dom
import {
  act,
  createElement,
  Fragment,
  useState,
  type ComponentProps,
  type ComponentType,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { WorkflowBuilder } from './WorkflowBuilder.js';
import {
  builderObject,
  builderSteps,
  createBuilderDocument,
  type BuilderDocument,
} from './builder-model.js';

// Render canvas cards without relying on browser layout measurements.
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    Handle: () => null,
    Background: () => null,
    Controls: () => null,
    ReactFlow: ({
      nodes,
      nodeTypes,
    }: {
      nodes: Array<{ id: string; data: Record<string, unknown> }>;
      nodeTypes: Record<string, ComponentType<{ id: string; data: Record<string, unknown> }>>;
    }) =>
      createElement(
        Fragment,
        null,
        nodes.map((node) => createElement(nodeTypes.block!, { ...node, key: node.id })),
      ),
  };
});

let root: Root;
let host: HTMLDivElement;
let current: BuilderDocument;
const fixture = () =>
  createBuilderDocument({
    irVersion: 3,
    inputSchema: { required: { orderId: { type: 'string' } } },
    startStepId: 'create',
    steps: [
      {
        id: 'create',
        kind: 'capabilityCall',
        capabilityVersionId: 'create@1',
        inputSchema: { required: { orderId: { type: 'string' } } },
        arguments: { orderId: { source: 'input', path: ['orderId'] } },
        responseSchema: { required: { id: { type: 'string' } } },
        retryPolicy: { maximumAttempts: 3 },
        next: 'send',
      },
      {
        id: 'send',
        kind: 'capabilityCall',
        capabilityVersionId: 'send@1',
        inputSchema: { required: { fulfillmentId: { type: 'string' } } },
        arguments: { fulfillmentId: { source: 'stepOutput', stepId: 'create', path: ['id'] } },
        responseSchema: { required: { ticketId: { type: 'string' } } },
        next: 'finish',
      },
      {
        id: 'finish',
        kind: 'terminal',
        state: 'completed',
        output: { source: 'literal', value: {} },
      },
    ],
  });
async function mount(extra: Partial<ComponentProps<typeof WorkflowBuilder>> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState(fixture);
    current = value;
    return createElement(WorkflowBuilder, {
      document: value,
      onChange: setValue,
      capabilities: [],
      ...extra,
    });
  }
  await act(async () => root.render(createElement(Harness)));
}
function card(id: string) {
  // Field labels identify the rendered card independently of the graph implementation.
  return [...host.querySelectorAll('.wb-block')].find(
    (node) => node.querySelector('.wb-block-title strong')?.textContent === id,
  )!;
}
function selectField(node: Element, label: string) {
  const field = [...node.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  return node.querySelector<HTMLSelectElement>(`select[id="${field?.htmlFor}"]`)!;
}
async function change(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

describe('inline Builder controls', () => {
  it('removes a capability step and its connections from the board, and restores it with Undo', async () => {
    await mount();
    const before = current;
    const remove = card('send').querySelector<HTMLButtonElement>(
      '[aria-label="Remove send from workflow"]',
    )!;
    await act(async () => remove.click());
    expect(builderSteps(current).map((step) => step.id)).toEqual(['create', 'finish']);
    expect(builderSteps(current)[0]!.next).toBe('');
    expect(current.layout.send).toBeUndefined();
    expect(host.querySelector<HTMLDialogElement>('.wb-settings-dialog')?.open).toBe(false);
    const undo = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Undo',
    )!;
    await act(async () => undo.click());
    expect(current).toEqual(before);
    expect(card('send')).toBeDefined();
  });
  it('shows named sources and outputs, edits the real mapping, and supports undo', async () => {
    await mount();
    const field = selectField(card('send'), 'fulfillmentId');
    const columns = card('send').querySelector('.wb-capability-columns')!;
    expect([...columns.children].map((section) => section.className)).toEqual([
      'wb-card-inputs',
      'wb-card-controls',
      'wb-card-outputs',
    ]);
    expect(field.closest('.wb-card-inputs')).not.toBeNull();
    expect(card('send').querySelector('.wb-card-controls .wb-block-settings')).toBeNull();
    expect(card('send').querySelector('.wb-card-controls .wb-advanced')).toBeNull();
    expect(card('send').querySelector('.wb-card-controls .wb-next-fields')).toBeNull();
    expect(card('send').querySelector('.wb-card-outputs .wb-schema')).not.toBeNull();
    expect(field.selectedOptions[0]?.textContent).toContain('create');
    expect(card('send').querySelector('.wb-block-outputs')?.textContent).toContain('ticketId');
    const source = [...field.options].find((option) => option.textContent?.includes('Start'))!;
    await change(field, source.value);
    expect(builderObject(builderSteps(current)[1]!.arguments).fulfillmentId).toEqual({
      source: 'input',
      path: ['orderId'],
    });
    expect(builderSteps(current)[0]!.retryPolicy).toEqual({ maximumAttempts: 3 });
    const undo = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Undo',
    )!;
    await act(async () => undo.click());
    expect(builderObject(builderSteps(current)[1]!.arguments).fulfillmentId).toEqual({
      source: 'stepOutput',
      stepId: 'create',
      path: ['id'],
    });
    expect(host.querySelector<HTMLDialogElement>('.wb-settings')?.open).toBe(false);
  });

  it('updates inline controls without opening settings, then opens the card modal and closes with Escape', async () => {
    await mount();
    await change(selectField(card('Start'), 'Start method'), 'webhook');
    expect(current.trigger.type).toBe('webhook');
    expect(card('Start').querySelector('.wb-output-fields')?.textContent).toContain('orderId');
    await act(async () => selectField(card('send'), 'fulfillmentId').click());
    const dialog = host.querySelector<HTMLDialogElement>('.wb-settings')!;
    expect(dialog.open).toBe(false);
    await act(async () => card('send').querySelector<HTMLElement>('.wb-block-title')!.click());
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('.wb-advanced')).not.toBeNull();
    expect(dialog.querySelector('.wb-next-fields')).not.toBeNull();
    await act(async () => {
      dialog.dispatchEvent(new Event('cancel'));
    });
    expect(dialog.open).toBe(false);
    expect(host.querySelector('.wb-block-settings')).toBeNull();
  });

  it('disables inline edits in read-only workflows', async () => {
    await mount({ readOnly: true });
    expect(selectField(card('Start'), 'Start method').disabled).toBe(true);
    expect(selectField(card('send'), 'fulfillmentId').disabled).toBe(true);
    expect(card('send').querySelector<HTMLButtonElement>('.wb-remove-block')?.disabled).toBe(true);
    expect(card('Start').querySelector('.wb-remove-block')).toBeNull();
    expect(
      card('send').querySelector<HTMLButtonElement>('[aria-label="Remove field ticketId"]')
        ?.disabled,
    ).toBe(true);
    expect(current.executable).toEqual(fixture().executable);
  });

  it('edits output fields on the right without changing input mappings', async () => {
    await mount();
    const before = builderSteps(current)[1]!.arguments;
    const remove = card('send').querySelector<HTMLButtonElement>(
      '.wb-card-outputs [aria-label="Remove field ticketId"]',
    )!;
    await act(async () => remove.click());
    expect(builderSteps(current)[1]!.responseSchema).toEqual({ required: {} });
    expect(builderSteps(current)[1]!.arguments).toEqual(before);
  });
});
