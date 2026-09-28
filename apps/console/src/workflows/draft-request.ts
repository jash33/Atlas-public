import type { DraftingState } from './drafting-state.js';
import type { RequestEditor } from './request-editor.js';

export interface DraftReferenceHints {
  references: Array<
    | {
        start: number;
        end: number;
        text: string;
        kind: 'capability' | 'requestField' | 'responseField';
        capabilityVersionId: string;
        direction?: 'request' | 'response';
        path?: string;
      }
    | {
        start: number;
        end: number;
        text: string;
        kind: 'runtimeInput';
        inputName: string;
      }
  >;
}

export function referenceHintsForDraft(
  editor: RequestEditor,
  request: string,
): DraftReferenceHints | undefined {
  if (editor.text !== request) return undefined;
  const references: DraftReferenceHints['references'] = [];
  for (const annotation of editor.annotations) {
    const text = request.slice(annotation.start, annotation.end);
    if (!text) continue;
    if (annotation.kind === 'runtime-input') {
      references.push({
        start: annotation.start,
        end: annotation.end,
        text,
        kind: 'runtimeInput',
        inputName: annotation.inputName,
      });
      continue;
    }
    references.push({
      start: annotation.start,
      end: annotation.end,
      text,
      kind:
        annotation.kind === 'request-field'
          ? 'requestField'
          : annotation.kind === 'response-field'
            ? 'responseField'
            : 'capability',
      capabilityVersionId: annotation.capabilityVersionId,
      ...(annotation.direction ? { direction: annotation.direction } : {}),
      ...(annotation.path ? { path: annotation.path } : {}),
    });
  }
  if (references.length === 0) return undefined;
  return { references };
}

export function draftRequestBody(
  scope: { organizationId: string; environmentId: string; workflowVersionId: string },
  state: DraftingState,
  editor: RequestEditor,
) {
  const referenceHints = referenceHintsForDraft(editor, state.request);
  const body = {
    ...scope,
    request: state.request,
    ...(referenceHints ? { referenceHints } : {}),
    ...(state.revisionContext ? { revisionContext: state.revisionContext } : {}),
  };
  if (state.continuation && state.answer)
    return {
      ...body,
      continuation: state.continuation,
      answer: state.answer,
      ...(state.mapping ? { mapping: state.mapping } : {}),
    };
  if (state.sandboxRepair && state.revisionContext)
    return { ...body, sandboxRepair: state.sandboxRepair };
  return body;
}
