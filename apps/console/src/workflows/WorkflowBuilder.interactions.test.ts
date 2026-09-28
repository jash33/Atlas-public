// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

import { WorkflowBuilder } from './WorkflowBuilder.js';
import {
  createBuilderDocument,
  type BuilderCapability,
  type BuilderDocument,
} from './builder-model.js';

const capabilities: BuilderCapability[] = [
  {
    capabilityVersionId: 'list-orders@1',
    label: 'List orders',
    description: 'Find the current orders',
    kind: 'capabilityCall',
    inputSchema: { required: {} },
    responseSchema: { required: {} },
  },
  {
    capabilityVersionId: 'find-customer@1',
    label: 'Find customer',
    description: 'Find a customer by ID',
    kind: 'capabilityCall',
    inputSchema: { required: {} },
    responseSchema: { required: {} },
  },
];
const generatedWorkflow = {
  irVersion: 2,
  steps: [
    {
      id: 'list_orders',
      kind: 'capabilityCall',
      capabilityVersionId: 'list-orders@1',
      arguments: {},
      responseSchema: { required: {} },
    },
    { id: 'finish', kind: 'terminal', state: 'completed' },
  ],
};

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn<(document: BuilderDocument) => void>();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onChange.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Builder({
  available = capabilities,
  customLabel,
}: {
  available?: BuilderCapability[];
  customLabel?: string;
}) {
  const [document, setDocument] = useState(() => {
    const document = createBuilderDocument(generatedWorkflow, capabilities);
    if (customLabel !== undefined) document.labels.list_orders = customLabel;
    return document;
  });
  return createElement(WorkflowBuilder, {
    document,
    capabilities: available,
    onChange: (next) => {
      onChange(next);
      setDocument(next);
    },
  });
}

async function click(selector: string) {
  const element = container.querySelector(selector);
  expect(element).not.toBeNull();
  await act(async () => element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

it.each(['.react-flow__pane', '[data-id="list_orders"]'])(
  'keeps the real canvas mounted when first clicking %s, then switching steps',
  async (selector) => {
    await act(async () => root.render(createElement(Builder)));
    await click(selector);
    for (let index = 0; index < 3; index++) {
      await click('[data-id="list_orders"]');
      expect(container.querySelector('.wb-settings')?.textContent).toContain(
        'Authorized capability',
      );
      expect(
        container.querySelector('[data-id="list_orders"]')?.classList.contains('selected'),
      ).toBe(true);
      await click('[data-id="finish"]');
      expect(container.querySelector('.wb-settings')?.textContent).toContain('Workflow result');
      await click('.react-flow__pane');
      expect(container.querySelector('.wb-canvas')).not.toBeNull();
    }
    expect(onChange).not.toHaveBeenCalled();
  },
);

it('names imported capability blocks using the authorized catalog', async () => {
  await act(async () => root.render(createElement(Builder)));
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'List orders',
  );
  expect(container.querySelector('[data-id="list_orders"] .wb-block-subtitle')?.textContent).toBe(
    'Find the current orders',
  );
  expect(container.querySelector('select[aria-label="Next step"]')?.textContent).toContain(
    'List orders',
  );
  await click('[data-id="list_orders"]');
  expect(container.querySelector('.wb-settings h3')?.textContent).toBe('List orders');
});

it('updates names after the catalog loads without modifying the document', async () => {
  await act(async () => root.render(createElement(Builder, { available: [] })));
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'list orders',
  );
  expect(container.querySelector('[data-id="list_orders"] .wb-block-subtitle')?.textContent).toBe(
    'list-orders@1',
  );
  await act(async () => root.render(createElement(Builder, { available: capabilities })));
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'List orders',
  );
  expect(onChange).not.toHaveBeenCalled();
});

it('preserves custom names while showing which capability the step calls', async () => {
  await act(async () => root.render(createElement(Builder, { customLabel: 'Load active orders' })));
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'Load active orders',
  );
  expect(container.querySelector('[data-id="list_orders"] .wb-block-subtitle')?.textContent).toBe(
    'List orders',
  );
  await click('[data-id="list_orders"]');
  expect(container.querySelector<HTMLInputElement>('#wb-label')?.value).toBe('Load active orders');
  expect(container.querySelector('.wb-settings h3')?.textContent).toBe('Load active orders');
  expect(onChange).not.toHaveBeenCalled();
});

it('keeps edits, selection, and undo working after choosing a different capability', async () => {
  await act(async () => root.render(createElement(Builder)));
  await click('[data-id="list_orders"]');
  const select = container.querySelector<HTMLSelectElement>('.wb-settings select');
  expect(select).not.toBeNull();
  await act(async () => {
    if (!select) return;
    select.value = 'find-customer@1';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'Find customer',
  );
  await click('.wb-toolbar button[title="Undo (Ctrl+Z)"]');
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'List orders',
  );
  await click('.wb-toolbar button[title="Redo (Ctrl+Shift+Z)"]');
  expect(container.querySelector('[data-id="list_orders"] .wb-block-title')?.textContent).toContain(
    'Find customer',
  );
  await click('[data-id="finish"]');
  expect(container.querySelector('.wb-settings h3')?.textContent).toBe('Finish');
});
