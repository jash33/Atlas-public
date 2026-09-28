import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createBuilderDocument, type BuilderDocument } from './builder-model.js';
import { WorkflowBuilder } from './WorkflowBuilder.js';
import { BuilderExpressionField } from './WorkflowBuilderFields.js';

describe('manual workflow builder', () => {
  it('offers core blocks and an accessible alternative to drawing connections', () => {
    const markup = renderToStaticMarkup(
      createElement(WorkflowBuilder, {
        document: createBuilderDocument(),
        capabilities: [],
        onChange: vi.fn<(document: BuilderDocument) => void>(),
      }),
    );
    for (const label of [
      'Find a block',
      'Set fields',
      'Conditional',
      'Sleep',
      'Finish',
      'Note',
      'Start method',
      'Input fields',
      'Next step',
      'Undo',
      'Fit to view',
    ])
      expect(markup).toContain(label);
    expect(markup).not.toContain('Slack');
    expect(markup).not.toContain('Notion');
  });

  it('locks unsupported content instead of rebuilding or discarding it', () => {
    const onChange = vi.fn<(document: BuilderDocument) => void>();
    const document = createBuilderDocument({
      irVersion: 7,
      steps: [{ id: 'future', kind: 'future' }],
    });
    const markup = renderToStaticMarkup(
      createElement(WorkflowBuilder, { document, capabilities: [], onChange }),
    );
    expect(markup).toContain('original definition is preserved');
    expect(markup).toContain('disabled=""');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps references to unavailable fields visible instead of changing their value', () => {
    const onChange = vi.fn<(value: unknown) => void>();
    const markup = renderToStaticMarkup(
      createElement(BuilderExpressionField, {
        label: 'Payment ID',
        value: { source: 'stepOutput', stepId: 'removed', path: ['id'] },
        options: [],
        onChange,
      }),
    );
    expect(markup).toContain('Saved reference');
    expect(markup).toContain('preserved');
    expect(onChange).not.toHaveBeenCalled();
  });
});
