import type { ClarificationMapping, SuggestedAnswerSelection } from './drafting-state.js';
import type { VerifiedCapabilityIdentity } from './validated-request.js';

export interface ClarificationDiagramNode {
  id: string;
  label: string;
  detail: string;
  kind: 'capability' | 'input';
  focus: boolean;
  source: boolean;
}

export interface ClarificationDiagramModel {
  nodes: ClarificationDiagramNode[];
  focusLabel: string;
  sourceLabel: string;
}

export function clarificationDiagram(input: {
  identities: readonly VerifiedCapabilityIdentity[];
  mapping: ClarificationMapping;
  selection: SuggestedAnswerSelection;
}): ClarificationDiagramModel {
  const identityById = new Map(
    input.identities.map((identity) => [identity.capabilityVersionId, identity]),
  );
  const destinationIdentity = identityById.get(input.mapping.destinationCapabilityVersionId);
  const source = candidateSource(input.selection.candidateId);
  const sourceStep =
    source.kind === 'step'
      ? input.mapping.sourceSteps.find(({ stepId }) => stepId === source.stepId)
      : undefined;
  const sourceIdentity = sourceStep ? identityById.get(sourceStep.capabilityVersionId) : undefined;
  const sourcePath = pointer(source.path);
  const destinationPath = pointer(input.selection.destinationPath);
  const sourceNode: ClarificationDiagramNode =
    source.kind === 'input'
      ? {
          id: `input:${source.path.join('.')}`,
          label: 'Workflow input',
          detail: sourcePath,
          kind: 'input',
          focus: false,
          source: true,
        }
      : {
          id: `source:${source.stepId}`,
          label: sourceIdentity?.operationId ?? source.stepId,
          detail: `response ${sourcePath}`,
          kind: 'capability',
          focus: false,
          source: true,
        };
  const destinationNode: ClarificationDiagramNode = {
    id: `destination:${input.mapping.destinationStepId}`,
    label: destinationIdentity?.operationId ?? input.mapping.destinationStepId,
    detail: `request ${destinationPath}`,
    kind: 'capability',
    focus: true,
    source: false,
  };

  return {
    nodes: [sourceNode, destinationNode],
    sourceLabel: `${sourceNode.label} ${sourcePath}`,
    focusLabel: `${destinationNode.label} ${destinationPath}`,
  };
}

function candidateSource(candidateId: string) {
  const encoded = candidateId.split('<-')[1]?.replace(/:convert$/, '') ?? '';
  if (encoded.startsWith('input:')) {
    return { kind: 'input' as const, path: pathSegments(encoded.slice('input:'.length)) };
  }
  const [stepId = 'previous-step', path = ''] = encoded.slice('step:'.length).split(':', 2);
  return { kind: 'step' as const, stepId, path: pathSegments(path) };
}

function pathSegments(path: string) {
  return path.split('.').filter(Boolean);
}

function pointer(path: readonly string[]) {
  return `/${path.join('/')}`;
}
