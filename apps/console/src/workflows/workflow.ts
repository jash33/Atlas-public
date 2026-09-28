import type { WorkflowSandboxExecutionMethod } from '@atlas/demo-estate';

import type { DemoRole } from '../shell/session.js';
import { parse, stringify } from 'yaml';

export interface Diagnostic {
  kind: string;
  code: string;
  path: string;
  message: string;
}

export interface RetryPolicy {
  initialInterval: string;
  backoffCoefficient: number;
  maximumInterval: string;
  maximumAttempts: number;
  nonRetryableErrorTypes: string[];
}

export interface WorkflowStep {
  stepId: string;
  capabilityId: Record<string, unknown> | null;
  capabilityVersionId: string;
  verified: boolean;
  provenance: { repository: string; commit: string; path: string } | null;
  inputSchema: unknown;
  outputSchema: unknown;
  inputMappings: unknown;
  httpCall: { method: string; path: string } | null;
  conditions: unknown;
  retryPolicy: RetryPolicy | null;
  timeout: { startToClose: string; source: 'runtime-default' };
  idempotency: unknown;
  secretReference: string | null;
  compensation: unknown;
  irreversible: boolean;
}

export interface WorkflowArtifact extends Record<string, unknown> {
  workflowVersionId: string;
  irHash: string;
  executionRequirements: Record<string, unknown>;
  executable: Record<string, unknown>;
  mappingOrigins?: Array<{
    stepId: string;
    destinationPath: string[];
    origin: 'requested' | 'inferred';
  }>;
}

export interface WorkflowGraphEdge {
  fromStepId: string;
  toStepId: string;
  kind: 'next' | 'mapping' | 'compensation' | 'revalidation';
  label?: string;
  origin?: 'requested' | 'inferred';
  maxRevalidations?: number;
}

export interface WorkflowReview {
  workflowVersionId: string | null;
  artifact: WorkflowArtifact | null;
  source: { filename: string; yaml: string } | null;
  binding: {
    irHash: string | null;
    policyVersion: string;
    projectionFingerprint: string;
  };
  migration: {
    classification: string;
    capabilityDiff: unknown;
    fromCapabilityVersionId: string;
    toCapabilityVersionId: string;
  } | null;
  irreversibleBoundary: string | null;
  steps: WorkflowStep[];
  graph: {
    nodes: Array<{
      stepId: string;
      kind: string;
      irreversible: boolean;
      retryPolicy: RetryPolicy | null;
      terminalState: string | null;
    }>;
    edges: WorkflowGraphEdge[];
  };
  approval: { enabled: boolean; diagnostics: Diagnostic[] };
}

export interface VerifiedDraftAnnotation {
  start: number;
  end: number;
  text: string;
  kind: 'capability' | 'requestField' | 'responseField';
  capabilityVersionId: string;
  direction?: 'request' | 'response';
  path?: string;
  evidence: {
    projectionFingerprint: string;
    capabilityVersionId: string;
    path?: string;
    matchedTerms: readonly string[];
  };
}

export interface ValidatedWorkflowDraft {
  status: 'validated';
  originalRequest?: string;
  clarifiedRequest?: string;
  annotations?: VerifiedDraftAnnotation[];
  intentFingerprint?: string;
  projectionFingerprint: string;
  intentFrame?: unknown;
  draft: Record<string, unknown>;
  validation?: unknown;
}

export interface WorkflowVersionSummary {
  workflowVersionId: string;
  irHash: string;
  status: 'approved' | 'superseded' | 'current';
  approvedBy: string;
  approvedAt: string;
  runs: Array<{
    runId: string;
    paymentId: string;
    state: string;
    startedAt: string;
  }>;
}

export interface WorkflowVersionDiff {
  fromVersionId: string;
  toVersionId: string;
  addedSteps: unknown[];
  removedSteps: unknown[];
  changedSteps: unknown[];
  reorderedSteps: unknown[];
  capabilityVersionBumps: unknown[];
}

export interface WorkflowLifecycle {
  activationCandidates: Array<{
    candidateId: string;
    source: { workflowVersionId: string; capabilityVersionId: string };
    candidate: {
      workflowVersionId: string;
      capabilityVersionId: string;
      irHash: string;
      irVersion: number;
      requiredCapabilityVersionIds: string[];
      artifactId: string | null;
    };
    workerDeclarations: Array<{
      workerId: string;
      minimumIrVersion: number;
      maximumIrVersion: number;
      supported: boolean;
    }>;
    blockers: Array<{ code: string; message: string }>;
    activationEnabled: boolean;
  }>;
  rollbackActivations: Array<{
    activationId: string;
    previous: { workflowVersionId: string; capabilityVersionId: string };
    current: { workflowVersionId: string; capabilityVersionId: string };
    activatedBy: string;
    activatedAt: string;
    rollbackEnabled: boolean;
    blocker: string | null;
  }>;
}

export type PlanningResult =
  | ValidatedWorkflowDraft
  | {
      status: 'clarification_required';
      reason?: string;
      question: string;
      suggestedAnswers: [string, string, string];
      continuation?: string;
      intentFrame?: unknown;
    }
  | { status: 'unsupported'; reason: string }
  | {
      status: 'manual_review';
      reason: string;
      detail: string;
      validation?: { diagnostics?: Diagnostic[] };
    };

export type SandboxRunStatus =
  | 'not-run'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const sampleDemoWorkflowRequest =
  'When someone orders pickup, open a pickup order, start a ticket, add the burger, and send it to the kitchen.';

export function nextWorkflowVersionId(now = new Date()): string {
  const [date, time] = now.toISOString().split('T') as [string, string];
  return `workflow-${date.replaceAll('-', '')}-${time.replaceAll(':', '').replace('Z', '').replace('.', '-')}`;
}

export function workflowArtifactYaml(artifact: WorkflowArtifact): string {
  return stringify(artifact, { indent: 2, lineWidth: 0 });
}

export function parseWorkflowArtifactYaml(source: string): WorkflowArtifact {
  const artifact: unknown = parse(source);
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new TypeError('YAML must contain a workflow artifact');
  }
  const record = artifact as Record<string, unknown>;
  const executable = record.executable;
  if (!executable || typeof executable !== 'object' || Array.isArray(executable)) {
    throw new TypeError('YAML must contain an executable workflow');
  }
  if (
    typeof record.workflowVersionId !== 'string' ||
    typeof record.irHash !== 'string' ||
    !record.executionRequirements ||
    typeof record.executionRequirements !== 'object' ||
    Array.isArray(record.executionRequirements)
  ) {
    throw new TypeError('YAML must contain the complete reviewed workflow artifact');
  }
  return record as WorkflowArtifact;
}

export function immutableArtifactFieldsMatch(
  edited: WorkflowArtifact,
  reviewed: WorkflowArtifact,
): boolean {
  return (
    edited.workflowVersionId === reviewed.workflowVersionId &&
    edited.irHash === reviewed.irHash &&
    stringify(edited.executionRequirements, { sortMapEntries: true }) ===
      stringify(reviewed.executionRequirements, { sortMapEntries: true })
  );
}

export function approvalAffordance(
  role: DemoRole,
  review: WorkflowReview,
  hasUnvalidatedChanges = false,
) {
  if (role !== 'admin') {
    return { enabled: false, reason: 'Switch to Admin to approve this version.' };
  }
  if (hasUnvalidatedChanges) {
    return { enabled: false, reason: 'Save the YAML changes before approving this version.' };
  }
  const diagnostics = review.approval?.diagnostics ?? [];
  const count = diagnostics.length;
  if (!review.approval?.enabled || count > 0) {
    if (
      count > 0 &&
      diagnostics.every((diagnostic) => diagnostic.code === 'SANDBOX_TESTS_MISSING')
    ) {
      return {
        enabled: false,
        reason: 'Run the checks before approving this version.',
      };
    }
    return {
      enabled: false,
      reason: 'Resolve the remaining problems before approving this version.',
    };
  }
  return { enabled: true, reason: null };
}

export function sandboxApprovalAffordance(status: SandboxRunStatus) {
  if (status === 'passed') return { enabled: true, reason: null };
  if (status === 'failed') {
    return {
      enabled: false,
      reason: 'Fix the failed check and run checks again before approving this version.',
    };
  }
  if (status === 'cancelled') {
    return { enabled: false, reason: 'Run the checks again before approving this version.' };
  }
  if (status === 'timed_out') {
    return {
      enabled: false,
      reason: 'The checks took too long. Run them again before approving this version.',
    };
  }
  return {
    enabled: false,
    reason:
      status === 'running'
        ? 'Wait for the checks to finish before approving this version.'
        : 'Run the checks before approving this version.',
  };
}

export interface SandboxCheckOutcome {
  readonly status?: 'passed' | 'failed';
  readonly stepId?: string | null;
  readonly capabilityVersionId?: string | null;
  readonly detail?: string;
  readonly expectation?: string;
  readonly executionMethods?: readonly WorkflowSandboxExecutionMethod[];
}

export interface SandboxCheckIdentity {
  readonly capabilityVersionId: string;
  readonly serviceId: string;
  readonly operationId: string;
}

const leakedCheckIdentity =
  /irHash|suiteFingerprint|workerVersion|runtimeVersion|capabilityVersionId|documentHash|secretAlias|fingerprint/i;
const leakedCheckCode = /\b[A-Z][A-Z0-9_]{3,}\b/;
const leakedCheckHash = /\b[a-f0-9]{32,}\b/i;

export function sandboxResultSummary(
  status: 'passed' | 'failed',
  tests: ReadonlyArray<SandboxCheckOutcome> = [],
  options: {
    identities?: readonly SandboxCheckIdentity[];
    stepName?: (stepId: string) => string;
  } = {},
): string {
  if (status === 'passed') return 'This version is ready to approve.';
  const failed = tests.find((test) => test.status === 'failed') ?? tests[0];
  if (!failed) return 'A check failed.';
  const subject = sandboxFailureSubject(failed, options);
  const problem = ordinaryCheckProblem(failed.detail) ?? ordinaryCheckProblem(failed.expectation);
  if (subject && problem) return `${subject} failed because ${becauseClause(problem)}.`;
  if (subject) return `${subject} failed.`;
  if (problem) return `A check failed because ${becauseClause(problem)}.`;
  return 'A check failed.';
}

function sandboxFailureSubject(
  test: SandboxCheckOutcome,
  options: {
    identities?: readonly SandboxCheckIdentity[];
    stepName?: (stepId: string) => string;
  },
): string | undefined {
  if (test.stepId) {
    const named = (options.stepName ?? humanizeStepId)(test.stepId);
    return named.trim() || undefined;
  }
  const identity = test.capabilityVersionId
    ? options.identities?.find(
        (candidate) => candidate.capabilityVersionId === test.capabilityVersionId,
      )
    : undefined;
  const operationId = identity?.operationId?.trim();
  return operationId ? `The ${operationId} API action` : undefined;
}

function humanizeStepId(stepId: string): string {
  const spaced = stepId
    .replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!spaced) return stepId;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function ordinaryCheckProblem(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (
    leakedCheckIdentity.test(trimmed) ||
    leakedCheckCode.test(trimmed) ||
    leakedCheckHash.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed.replace(/[.!?]$/, '');
}

function becauseClause(problem: string): string {
  return problem.replace(/^(the|a|an)\s/i, (match) => match.toLowerCase());
}

export async function refreshReviewAfterSandboxRun<T>(
  status: SandboxRunStatus,
  refresh: () => Promise<T>,
): Promise<T | undefined> {
  if (status !== 'passed' && status !== 'failed') return undefined;
  return refresh();
}

export function graphEdgeLabel(edge: WorkflowGraphEdge): string {
  if (edge.kind === 'next' && edge.label) return edge.label;
  if (edge.kind === 'mapping') {
    const field = edge.label ?? 'data';
    if (edge.origin === 'requested') return `maps ${field} · you asked for this`;
    if (edge.origin === 'inferred') return `maps ${field} · Atlas inferred this`;
    return `maps ${field}`;
  }
  if (edge.kind === 'compensation') return 'compensates with';
  if (edge.kind === 'revalidation') {
    return edge.maxRevalidations
      ? `revalidates from (max ${edge.maxRevalidations})`
      : 'revalidates from';
  }
  return 'then';
}

export function retryPolicySummary(policy: RetryPolicy | null): string | null {
  if (!policy) return null;
  const nonRetryable =
    policy.nonRetryableErrorTypes.length > 0
      ? ` · ${policy.nonRetryableErrorTypes.join(', ')} does not retry`
      : '';
  return `${policy.maximumAttempts} attempts · ${policy.initialInterval} × ${policy.backoffCoefficient} up to ${policy.maximumInterval}${nonRetryable}`;
}

export function describeWorkflowFailure(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (record.error === 'planner-unavailable' && record.reason === 'credit_balance_exhausted') {
      return 'The OpenAI account has no credits left. Add credits, then try again.';
    }
    if (record.error === 'workflow-sandbox-execution-failed') {
      return 'The check runner was reached, but could not finish executing the checks. Retry checks for this version.';
    }
    if (record.error === 'workflow-sandbox-tests-unavailable') {
      return 'The check runner could not be reached.';
    }
    if (typeof record.error === 'string') return record.error.replaceAll('-', ' ');
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.reason === 'string') return record.reason;
  }
  return `Workflow request failed (${status})`;
}

export async function readWorkflowResponseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}
