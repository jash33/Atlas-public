import { YAMLParseError } from 'yaml';

import {
  diagramFromExecutable,
  diagramFromReviewGraph,
  type DiagramModel,
} from './diagram-model.js';
import type { VerifiedCapabilityIdentity } from './validated-request.js';
import {
  immutableArtifactFieldsMatch,
  parseWorkflowArtifactYaml,
  workflowArtifactYaml,
  type WorkflowReview,
} from './workflow.js';

export const UNSAVED_PREVIEW_BANNER = 'Unsaved preview - not validated';
export type DiagramPreview =
  | { status: 'hidden' }
  | { status: 'server'; graph: DiagramModel }
  | { status: 'draft-preview'; graph: DiagramModel }
  | { status: 'unsaved-preview'; graph: DiagramModel; banner: typeof UNSAVED_PREVIEW_BANNER }
  | { status: 'invalid-yaml'; detail: string; line?: number; column?: number }
  | { status: 'identity-changed'; detail: string };

export function resolveDiagramPreview(input: {
  identities?: readonly VerifiedCapabilityIdentity[];
  review: WorkflowReview | undefined;
  draft?: Record<string, unknown> | undefined;
  yaml: string;
}): DiagramPreview {
  const identities = input.identities ?? [];
  if (!input.review?.artifact) {
    if (!input.draft) return { status: 'hidden' };
    try {
      const draft = parseWorkflowArtifactYaml(JSON.stringify(input.draft));
      return {
        status: 'draft-preview',
        graph: diagramFromExecutable(draft.executable, identities, [], draft.mappingOrigins ?? []),
      };
    } catch {
      return { status: 'hidden' };
    }
  }
  const mappingOrigins = input.review.artifact.mappingOrigins ?? [];
  if (input.yaml === workflowArtifactYaml(input.review.artifact)) {
    return {
      status: 'server',
      graph: diagramFromReviewGraph(
        input.review.graph,
        input.review.steps,
        identities,
        mappingOrigins,
      ),
    };
  }
  try {
    const edited = parseWorkflowArtifactYaml(input.yaml);
    if (!immutableArtifactFieldsMatch(edited, input.review.artifact)) {
      return {
        status: 'identity-changed',
        detail:
          'Workflow identity fields are read-only. Restore them and edit only the executable section.',
      };
    }
    return {
      status: 'unsaved-preview',
      banner: UNSAVED_PREVIEW_BANNER,
      graph: diagramFromExecutable(
        edited.executable,
        identities,
        input.review.steps,
        edited.mappingOrigins ?? mappingOrigins,
      ),
    };
  } catch (cause) {
    return invalidYamlPreview(cause);
  }
}

function invalidYamlPreview(cause: unknown): Extract<DiagramPreview, { status: 'invalid-yaml' }> {
  if (cause instanceof YAMLParseError) {
    const location = cause.linePos?.[0];
    return {
      status: 'invalid-yaml',
      detail: cause.message,
      ...(location ? { line: location.line, column: location.col } : {}),
    };
  }
  return {
    status: 'invalid-yaml',
    detail: cause instanceof Error ? cause.message : 'YAML could not form a workflow graph',
  };
}
