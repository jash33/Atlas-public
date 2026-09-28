import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { isValidElement, type ReactNode } from 'react';

const state = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
const remove = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<{ deleted: true }>>());
vi.mock('./data.js', () => ({ deleteCapability: remove }));
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
import { DeleteCapability } from './DeleteCapability.js';

function buttons(
  node: ReactNode,
): Array<{ children?: ReactNode; onClick: () => void; disabled?: boolean }> {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<{ children?: ReactNode; onClick: () => void; disabled?: boolean }>(node))
    return [];
  return node.type === 'button' ? [node.props] : buttons(node.props.children);
}

beforeEach(() => {
  state.cells = [];
  state.cursor = 0;
  remove.mockReset();
});

describe('delete capability control', () => {
  it('requires confirmation, sends the selected scope, and refreshes after success', async () => {
    const onDeleted = vi.fn();
    remove.mockResolvedValue({ deleted: true });
    const render = () => {
      state.cursor = 0;
      return DeleteCapability({
        organizationId: 'org',
        environmentId: 'development',
        capabilityIdentityId: '42',
        name: 'List items',
        bearerToken: 'test',
        onDeleted,
      });
    };
    buttons(render())[0]!.onClick();
    expect(remove).not.toHaveBeenCalled();
    buttons(render())[0]!.onClick();
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith('org', 'development', '42', 'test');
  });

  it('keeps the control open and displays a deletion failure', async () => {
    const onDeleted = vi.fn();
    remove.mockRejectedValue(new Error('This capability is used by a saved workflow.'));
    const render = () => {
      state.cursor = 0;
      return DeleteCapability({
        organizationId: 'org',
        environmentId: 'production',
        capabilityIdentityId: '42',
        name: 'List items',
        bearerToken: 'test',
        onDeleted,
      });
    };
    buttons(render())[0]!.onClick();
    buttons(render())[0]!.onClick();
    await vi.waitFor(() =>
      expect(JSON.stringify(render())).toContain('This capability is used by a saved workflow.'),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(buttons(render())[0]!.disabled).toBe(false);
    buttons(render())[1]!.onClick();
    expect(buttons(render())).toHaveLength(1);
  });
});
