import { useState, type ReactNode } from 'react';
import { reasoningSections } from './reasoning-sections.js';
import { draftPreview, previewObject } from './draft-preview.js';
import { humanStepName } from './diagram-model.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

function mappingSource(value: unknown): string | undefined {
  const mapping = previewObject(value);
  const path =
    Array.isArray(mapping.path) && mapping.path.every((part) => typeof part === 'string')
      ? mapping.path.join('.')
      : '';
  if (mapping.source === 'input' && path) return `Workflow input: ${path}`;
  if (mapping.source === 'stepOutput' && typeof mapping.stepId === 'string' && path)
    return `${humanStepName(mapping.stepId)}: ${path}`;
  if (
    mapping.source === 'literal' &&
    ['string', 'number', 'boolean'].includes(typeof mapping.value)
  )
    return String(mapping.value);
  return undefined;
}

export function DraftPreview({ progress }: { progress: DraftRequestProgress }) {
  const preview = draftPreview(progress);
  const reasoning = reasoningSections(progress);
  const entries: { key: string; order: number; content: ReactNode }[] = reasoning.map(
    (section) => ({
      key: section.key,
      order: section.order,
      content: (
        <PreviewSection title={section.title} active={section.active} reasoning>
          <p className="wf-draft-reasoning" key={section.body ? 'body' : 'waiting'}>
            {section.body || (section.active ? 'Working...' : 'No additional details.')}
          </p>
        </PreviewSection>
      ),
    }),
  );
  if (preview.summary || preview.active === 'summary')
    entries.push({
      key: 'understanding',
      order: preview.summaryOrder,
      content: (
        <PreviewSection title="Understanding" active={preview.active === 'summary'}>
          {preview.summary && <p className="wf-draft-reasoning">{preview.summary}</p>}
        </PreviewSection>
      ),
    });
  if (preview.inputs.length || preview.active === 'inputs')
    entries.push({
      key: 'inputs',
      order: preview.summaryOrder + 0.1,
      content: (
        <PreviewSection title="Inputs needed" active={preview.active === 'inputs'}>
          <ul>
            {preview.inputs.map((input, index) => (
              <li key={index}>{input}</li>
            ))}
          </ul>
        </PreviewSection>
      ),
    });
  if (preview.steps.length || preview.active === 'steps')
    entries.push({
      key: 'steps',
      order: preview.stepsOrder,
      content: (
        <PreviewSection title="Proposed steps" active={preview.active === 'steps'}>
          <ol>
            {preview.steps.map((step, index) => (
              <li key={index}>
                <strong>{humanStepName(String(step.id))}</strong>
                <ul>
                  {Object.entries(previewObject(step.arguments)).map(([field, value]) => {
                    const source = mappingSource(value);
                    return source ? (
                      <li key={field}>
                        {field}: {source}
                      </li>
                    ) : null;
                  })}
                </ul>
              </li>
            ))}
          </ol>
        </PreviewSection>
      ),
    });
  entries.sort((left, right) => left.order - right.order);
  const running = progress.status === 'running';
  return (
    <section className="wf-draft-preview" aria-label="Live draft preview">
      {!entries.length && (
        <p>
          {running ? 'Waiting for the first draft details...' : 'No draft details were returned.'}
        </p>
      )}
      <div className="wf-reasoning-thread">
        {entries.map((entry) => (
          <div className="wf-inline-entry" key={entry.key}>
            {entry.content}
          </div>
        ))}
      </div>
    </section>
  );
}

function PreviewSection({
  title,
  children,
  active,
  reasoning = false,
}: {
  title: string;
  children: ReactNode;
  active: boolean;
  reasoning?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <details
      className="wf-reasoning-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="wf-reasoning-chevron" aria-hidden="true">
          &#8250;
        </span>
        <span className={active ? 'wf-heading-shimmer' : undefined}>{title}</span>
        {reasoning && active && (
          <span className="wf-draft-spinner" role="status" aria-label="Thinking" />
        )}
      </summary>
      {children}
    </details>
  );
}
