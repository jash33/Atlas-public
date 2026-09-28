import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
const create = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<unknown>>());
const update = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<unknown>>());
const remove = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<{ deleted: true }>>());

vi.mock('./data.js', () => ({
  createCapabilityUserAnnotation: create,
  updateCapabilityUserAnnotation: update,
  deleteCapabilityUserAnnotation: remove,
}));

vi.mock('react', async (original) => ({
  ...(await original()),
  useState(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.cells)) state.cells[index] = initial;
    return [
      state.cells[index],
      (value: unknown) => {
        state.cells[index] = value;
      },
    ];
  },
}));

import { CapabilityUserAnnotations } from './CapabilityUserAnnotations.js';

interface ButtonProps {
  children?: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

interface EditorProps {
  onChange: (body: string) => void;
  onSave: () => void;
}

function elements<T>(node: ReactNode, type: string): T[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements<T>(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return node.type === type ? [node.props as T] : elements<T>(node.props.children, type);
}

function button(node: ReactNode, label: string) {
  return elements<ButtonProps>(node, 'button').find((item) =>
    JSON.stringify(item.children).includes(label),
  )!;
}

function component<T>(node: ReactNode, name: string): T {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = component<T | undefined>(child, name);
      if (match) return match;
    }
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined as T;
  if (typeof node.type === 'function' && node.type.name === name) return node.props as T;
  return component<T>(node.props.children, name);
}

const savedAnnotation = {
  id: '9',
  body: 'Use for wholesale orders only.',
  createdBy: 'avery',
  updatedBy: 'avery',
  createdAt: '2026-09-14T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:00.000Z',
};

beforeEach(() => {
  state.cells = [];
  state.cursor = 0;
  create.mockReset();
  update.mockReset();
  remove.mockReset();
});

function render(annotations = [savedAnnotation], onChanged = vi.fn<() => void>()) {
  state.cursor = 0;
  return {
    node: CapabilityUserAnnotations({
      annotations,
      bearerToken: 'member-token',
      capabilityIdentityId: '42',
      organizationId: 'org',
      onChanged,
    }),
    onChanged,
  };
}

describe('capability user annotations', () => {
  it('adds business context and refreshes the capability', async () => {
    create.mockResolvedValue({});
    const onChanged = vi.fn<() => void>();
    button(render([], onChanged).node, 'Add business context').onClick();
    component<EditorProps>(render([], onChanged).node, 'AnnotationEditor').onChange(
      'Route priority orders through the concierge team.',
    );
    component<EditorProps>(render([], onChanged).node, 'AnnotationEditor').onSave();

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      'org',
      '42',
      'Route priority orders through the concierge team.',
      'member-token',
    );
  });

  it('edits existing context', async () => {
    update.mockResolvedValue({});
    const onChanged = vi.fn<() => void>();
    button(render(undefined, onChanged).node, 'Edit').onClick();
    component<EditorProps>(render(undefined, onChanged).node, 'AnnotationEditor').onChange(
      'Use for retail orders only.',
    );
    component<EditorProps>(render(undefined, onChanged).node, 'AnnotationEditor').onSave();

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(
      'org',
      '42',
      '9',
      'Use for retail orders only.',
      'member-token',
    );
  });

  it('requires confirmation before deleting context', async () => {
    remove.mockResolvedValue({ deleted: true });
    const onChanged = vi.fn<() => void>();
    button(render(undefined, onChanged).node, 'Delete').onClick();
    expect(remove).not.toHaveBeenCalled();
    button(render(undefined, onChanged).node, 'Confirm delete').onClick();

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith('org', '42', '9', 'member-token');
  });
});
