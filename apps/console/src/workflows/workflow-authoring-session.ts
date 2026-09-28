import { consoleFetch } from '../shell/api.js';
import {
  continueDraftProgress,
  followDraftRequest,
  type DraftRequestProgress,
} from './draft-request-progress.js';
import {
  followWorkflowCheckRequest,
  type WorkflowCheckProgress,
  type WorkflowCheckRequestState,
} from './workflow-check-request.js';
import { useEffect, useRef, useState } from 'react';
import type {
  WorkflowSandboxExecutionMethod,
  WorkflowSandboxProviderContractWire,
  WorkflowSandboxTestWire,
} from '@atlas/demo-estate';

import { consoleConfig, demoTokenForRole } from '../config.js';
import { parseHashParameter, useLocationHash } from '../shell/router.js';
import { useConsoleSession } from '../shell/session.js';
import {
  loadCatalogWorkflowReview,
  saveWorkflowCatalogDraft,
} from '../workflow-catalog/catalog.js';

import {
  closeCapabilityDrawer,
  openCapabilityDrawer,
  type CapabilityDrawerState,
} from './diagram-drawer.js';
import { humanStepName } from './diagram-model.js';
import { resolveDiagramPreview, type DiagramPreview } from './diagram-preview.js';
import { explainCheckFailure } from './check-failure.js';

import {
  builderCapabilitiesFromProjection,
  createBuilderDocument,
  type BuilderCapability,
  type BuilderDocument,
} from './builder-model.js';
import { useManualWorkflow } from './manual-workflow-session.js';
import { workflowExecutableKey } from './manual-workflow.js';

import { draftRequestBody } from './draft-request.js';
import {
  cancelDraft,
  createDraftingState,
  editRequest,
  environmentActionForAnswer,
  receiveDraftResponse,
  reviseRequest,
  submitClarificationAnswer,
  submitDraft,
  submitDraftRevision,
  type DraftResponse,
  type DraftingState,
} from './drafting-state.js';

import { applyReferenceIndex, createRequestEditor } from './request-editor.js';

import {
  approvalAffordance,
  describeWorkflowFailure,
  immutableArtifactFieldsMatch,
  readWorkflowResponseJson,
  sampleDemoWorkflowRequest,
  nextWorkflowVersionId,
  parseWorkflowArtifactYaml,
  refreshReviewAfterSandboxRun,
  sandboxApprovalAffordance,
  workflowArtifactYaml,
  type SandboxRunStatus,
  type ValidatedWorkflowDraft,
  type WorkflowReview,
} from './workflow.js';

interface ReviewRequest {
  organizationId: string;
  environmentId: string;
  projectionFingerprint: string;
  draft: Record<string, unknown>;
  migrationCandidateId?: string;
}

interface MigrationCandidate {
  candidateId: string;
  environmentId: string;
  fromCapabilityVersionId: string;
  toCapabilityVersionId: string;
  draft: Record<string, unknown>;
}

interface WorkflowSandboxResult {
  testRunId: string;
  workflowVersionId: string;
  irHash: string;
  suiteFingerprint: string;
  setupBinding: {
    capabilityVersions: Array<{
      capabilityVersionId: string;
      sourceDocumentHash: string;
      secretAlias: string | null;
    }>;
    targets: Array<{
      capabilityVersionId: string;
      targetKey: string;
      targetRevision: number;
      testDataProfileKey: string;
      testDataVersion: number;
      secretAlias: string | null;
    }>;
    workerVersion: string;
    runtimeVersion: string;
    executionMethods: WorkflowSandboxExecutionMethod[];
    environmentId: string;
    testedAt: string;
  };
  status: 'passed' | 'failed';
  providerContracts: WorkflowSandboxProviderContractWire[];
  tests: Array<
    WorkflowSandboxTestWire & {
      status: 'passed' | 'failed';
      detail?: string;
      executionMethods: WorkflowSandboxExecutionMethod[];
    }
  >;
  testedBy: string;
  testedAt: string;
}

interface WorkflowSandboxState {
  status: SandboxRunStatus;
  progress?: WorkflowCheckProgress;
  result?: WorkflowSandboxResult;
  error?: string;
}

const emptySandboxState: WorkflowSandboxState = { status: 'not-run' };
const emptyBuilderDocumentKey = workflowExecutableKey(createBuilderDocument());

export function useWorkflowAuthoringSession() {
  const { organizationId, environmentId, role, setEnvironmentId, customerUser } =
    useConsoleSession();
  const locationHash = useLocationHash();
  const [editor, setEditor] = useState(() =>
    createRequestEditor({ text: sampleDemoWorkflowRequest }),
  );
  const prompt = editor.text;
  const [drafting, setDrafting] = useState(() => createDraftingState(sampleDemoWorkflowRequest));
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [revisionPrompt, setRevisionPrompt] = useState('');
  const [workflowName, setWorkflowName] = useState('');
  const [workflowId, setWorkflowId] = useState(() => `workflow_${crypto.randomUUID()}`);
  const [review, setReview] = useState<WorkflowReview>();
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest>();
  const [builderValidation, setBuilderValidation] = useState<{
    executableKey: string;
    workflowVersionId: string | null;
  }>();
  const [editorMode, setEditorMode] = useState<'ai' | 'builder'>('ai');
  useEffect(() => {
    if (editorMode === 'builder') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [editorMode]);
  const [builderOpened, setBuilderOpened] = useState(false);
  const [builderCapabilities, setBuilderCapabilities] = useState<BuilderCapability[]>([]);
  const [builderProjection, setBuilderProjection] = useState<string>();
  const [builderLoadError, setBuilderLoadError] = useState<string>();
  const [savedManualDrafts, setSavedManualDrafts] = useState<
    Array<{ workflowId: string; name: string }>
  >([]);
  const [savedDraftListVersion, setSavedDraftListVersion] = useState(0);
  const [savedDraftListStatus, setSavedDraftListStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [aiProposal, setAiProposal] = useState<{ state: DraftingState; baseline: string }>();
  const manual = useManualWorkflow({
    scope: { organizationId, environmentId, workflowId },
    enabled: builderOpened,
    preferSaved: Boolean(parseHashParameter(locationHash, 'editorWorkflowId')),
    token: demoTokenForRole(role),
    name: workflowName,
    executable: reviewRequest?.draft.executable,
    onLoadName: setWorkflowName,
  });
  const hasBuilderWork =
    builderOpened &&
    (manual.revision !== null ||
      workflowExecutableKey(manual.document) !== emptyBuilderDocumentKey);
  const [artifactYaml, setArtifactYaml] = useState('');
  const [diagramPreview, setDiagramPreview] = useState<DiagramPreview>({ status: 'hidden' });
  const [capabilityDrawer, setCapabilityDrawer] = useState<CapabilityDrawerState>({
    capabilityVersionId: null,
    restoreFocusStepId: null,
  });
  const [editMessage, setEditMessage] = useState<string>();
  const [editError, setEditError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [approvalMessage, setApprovalMessage] = useState<string>();
  const [sandbox, setSandbox] = useState<WorkflowSandboxState>(emptySandboxState);
  const [draftProgress, setDraftProgress] = useState<DraftRequestProgress>();
  const [draftConnectionLost, setDraftConnectionLost] = useState(false);
  const activeDraftUrl = useRef<string | undefined>(undefined);
  const draftOwnerId = customerUser?.actorId;
  const draftStorageKey = `atlas-draft:${organizationId}:${environmentId}:${draftOwnerId ?? role}`;
  const draftAttemptId = useRef(0);
  const draftAbortController = useRef<AbortController | undefined>(undefined);
  const draftCancelFallback = useRef<DraftingState | undefined>(undefined);
  const checkAbortController = useRef<AbortController | undefined>(undefined);
  const activeCheckUrl = useRef<string | undefined>(undefined);
  const checkAttemptId = useRef(0);
  const openedMigrationCandidateId = useRef<string | undefined>(undefined);
  const openedCatalogWorkflowVersion = useRef<string | undefined>(undefined);

  useEffect(() => {
    draftAbortController.current?.abort();
    draftAbortController.current = undefined;
    draftCancelFallback.current = undefined;
    openedMigrationCandidateId.current = undefined;
    openedCatalogWorkflowVersion.current = undefined;
    draftAttemptId.current += 1;

    setDrafting((current) => createDraftingState(current.request));
    setClarificationAnswer('');
    setRevisionPrompt('');
    setWorkflowName('');
    setWorkflowId(`workflow_${crypto.randomUUID()}`);
    setEditorMode('ai');
    setBuilderOpened(false);
    setAiProposal(undefined);
    clearReviewSurfaces();

    setError(undefined);
    setBusy(false);
  }, [environmentId, organizationId, draftOwnerId]);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ organizationId, environmentId });
    setSavedManualDrafts([]);
    if (role !== 'author' && role !== 'admin') {
      setSavedDraftListStatus('ready');
      return;
    }
    setSavedDraftListStatus('loading');
    void consoleFetch(`${consoleConfig.backendUrl}/v1/workflow-editor-drafts?${query}`, {
      headers: { authorization: `Bearer ${demoTokenForRole(role)}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load saved drafts.');
        const body: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!body || typeof body !== 'object' || !('drafts' in body) || !Array.isArray(body.drafts))
          throw new Error('Could not load saved drafts.');
        setSavedManualDrafts(
          body.drafts.flatMap((draft: unknown) =>
            draft &&
            typeof draft === 'object' &&
            'workflowId' in draft &&
            typeof draft.workflowId === 'string' &&
            'name' in draft &&
            typeof draft.name === 'string'
              ? [{ workflowId: draft.workflowId, name: draft.name }]
              : [],
          ),
        );
        setSavedDraftListStatus('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setSavedDraftListStatus('error');
      });
    return () => controller.abort();
  }, [organizationId, environmentId, role, savedDraftListVersion]);

  useEffect(() => {
    if (!hasBuilderWork || !manual.dirty || typeof window === 'undefined') return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasBuilderWork, manual.dirty]);

  useEffect(() => {
    const id = parseHashParameter(locationHash, 'editorWorkflowId');
    if (!id) return;
    if (id !== workflowId) {
      draftAbortController.current?.abort();
      checkAbortController.current?.abort();
      draftAttemptId.current += 1;
      checkAttemptId.current += 1;
      clearReviewSurfaces();
      setAiProposal(undefined);
      setWorkflowName('');
      setDraftProgress(undefined);
      setDrafting(createDraftingState(''));
    }
    setWorkflowId(id);
    setEditorMode('builder');
    setBuilderOpened(true);
    // Follow navigation, rather than changes made while saving the same workflow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, organizationId, locationHash]);

  useEffect(() => {
    if (!builderOpened) return;
    const controller = new AbortController();
    setBuilderCapabilities([]);
    setBuilderProjection(undefined);
    setBuilderLoadError(undefined);
    const query = new URLSearchParams({ organizationId, environmentId });
    void consoleFetch(`${consoleConfig.backendUrl}/v1/planner-capabilities?${query}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await readWorkflowResponseJson(response);
        if (!response.ok) throw new Error(describeWorkflowFailure(response.status, body));
        if (controller.signal.aborted) return;
        if (
          !body ||
          typeof body !== 'object' ||
          !('fingerprint' in body) ||
          typeof body.fingerprint !== 'string'
        ) {
          throw new Error('Capability information could not be loaded.');
        }
        setBuilderCapabilities(builderCapabilitiesFromProjection(body));
        setBuilderProjection(body.fingerprint);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setBuilderLoadError(
            cause instanceof Error ? cause.message : 'Capabilities could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [builderOpened, environmentId, organizationId]);

  useEffect(
    () => () => {
      draftAbortController.current?.abort();
      checkAbortController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const saved = sessionStorage.getItem(draftStorageKey);
    setDraftProgress(undefined);
    setDraftConnectionLost(false);
    if (!draftOwnerId) {
      sessionStorage.removeItem(draftStorageKey);
      return;
    }
    if (
      !saved ||
      parseHashParameter(locationHash, 'editorWorkflowId') ||
      parseHashParameter(locationHash, 'catalogWorkflowId') ||
      parseHashParameter(locationHash, 'migrationCandidateId')
    )
      return;
    let recovered: {
      url: string;
      state: DraftingState;
      workflowName: string;
      workflowId: string;
      cancelRequested?: boolean;
    };
    try {
      recovered = JSON.parse(saved);
    } catch {
      sessionStorage.removeItem(draftStorageKey);
      return;
    }
    const controller = new AbortController();
    draftAbortController.current = controller;
    draftAttemptId.current = recovered.state.requestId;
    setDrafting(recovered.state);
    setEditor(createRequestEditor({ text: recovered.state.request }));
    setWorkflowName(recovered.workflowName);
    setWorkflowId(recovered.workflowId);
    setBusy(true);
    const restore = async () => {
      if (recovered.cancelRequested) {
        activeDraftUrl.current = recovered.url;
        const response = await consoleFetch(recovered.url, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${demoTokenForRole(role)}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Cancellation was not confirmed. Try cancelling again.');
        controller.signal.throwIfAborted();
        setDraftProgress(await response.json());
        setDrafting(createDraftingState(recovered.state.request));
        return;
      }
      await postDraft(recovered.state, controller.signal, recovered);
    };
    void restore()
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Draft recovery failed.');
        setDrafting((current) => ({ ...current, phase: 'editing' }));
      })
      .finally(() => {
        if (!controller.signal.aborted) finishDraftRequest(recovered.state.requestId);
      });
    return () => controller.abort();
    // Recover once when the scope changes, not each time the editor renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftOwnerId, draftStorageKey, locationHash]);

  useEffect(() => {
    if (review?.artifact) setArtifactYaml(workflowArtifactYaml(review.artifact));
  }, [review]);

  useEffect(() => {
    setDiagramPreview(
      resolveDiagramPreview({
        identities:
          editor.index?.references.map((reference) => ({
            capabilityVersionId: reference.capabilityVersionId,
            serviceId: reference.identity.serviceId,
            operationId: reference.identity.operationId,
            owner: reference.owner,
            ...(reference.observation ? { observation: reference.observation } : {}),
          })) ?? [],
        review,
        draft: drafting.draft,
        yaml: artifactYaml,
      }),
    );
  }, [artifactYaml, editor.index, review, drafting.draft]);

  useEffect(() => {
    const controller = new AbortController();
    setEditor((current) => createRequestEditor({ text: current.text, cursor: current.cursor }));
    const query = new URLSearchParams({ organizationId, environmentId });
    void consoleFetch(`${consoleConfig.backendUrl}/v1/planner-capability-references?${query}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => ({ status: 'unavailable' }));
        if (controller.signal.aborted) return;
        setEditor((current) =>
          applyReferenceIndex(current, body, { organizationId, environmentId }),
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setEditor((current) =>
          applyReferenceIndex(
            current,
            { status: 'unavailable' },
            { organizationId, environmentId },
          ),
        );
      });
    return () => controller.abort();
  }, [environmentId, organizationId]);

  useEffect(() => {
    const workflowId = parseHashParameter(locationHash, 'catalogWorkflowId');
    const workflowVersionId = parseHashParameter(locationHash, 'catalogWorkflowVersionId');
    if (!workflowId || !workflowVersionId) return;
    const key = `${workflowId}\u0000${workflowVersionId}`;
    if (openedCatalogWorkflowVersion.current === key) return;
    openedCatalogWorkflowVersion.current = key;
    const controller = new AbortController();
    setBusy(true);
    setError(undefined);
    void loadCatalogWorkflowReview<WorkflowReview>(
      organizationId,
      environmentId,
      workflowId,
      workflowVersionId,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setWorkflowId(result.workflowId);
        setWorkflowName(result.name);
        setReviewRequest({
          organizationId,
          environmentId,
          projectionFingerprint: result.projectionFingerprint,
          draft: result.draft as Record<string, unknown>,
        });
        setReview(result.review);
        manual.importExecutable((result.draft as Record<string, unknown>).executable);
        invalidateChecks();
        if (parseHashParameter(locationHash, 'action') === 'edit') {
          setEditorMode('builder');
          setBuilderOpened(true);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        openedCatalogWorkflowVersion.current = undefined;
        setError(
          cause instanceof Error ? cause.message : 'Workflow version review could not be loaded',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
    // Only navigation should import a catalog version into the working document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, locationHash, organizationId]);

  useEffect(() => {
    const candidateId = parseHashParameter(locationHash, 'migrationCandidateId');
    if (!candidateId || openedMigrationCandidateId.current === candidateId) return;
    openedMigrationCandidateId.current = candidateId;
    const controller = new AbortController();
    setBusy(true);
    setError(undefined);
    const query = new URLSearchParams({ organizationId });
    const projectionQuery = new URLSearchParams({ organizationId, environmentId });
    void Promise.all([
      consoleFetch(
        `${consoleConfig.backendUrl}/v1/workflow-migration-candidates/${candidateId}?${query}`,
        {
          signal: controller.signal,
        },
      ),
      consoleFetch(`${consoleConfig.backendUrl}/v1/planner-capabilities?${projectionQuery}`, {
        signal: controller.signal,
      }),
    ])
      .then(async ([candidateResponse, projectionResponse]) => {
        const candidateBody: unknown = await readWorkflowResponseJson(candidateResponse);
        const projectionBody: unknown = await readWorkflowResponseJson(projectionResponse);
        if (!candidateResponse.ok) {
          throw new Error(describeWorkflowFailure(candidateResponse.status, candidateBody));
        }
        if (!projectionResponse.ok) {
          throw new Error(describeWorkflowFailure(projectionResponse.status, projectionBody));
        }
        const candidate = candidateBody as MigrationCandidate;
        if (candidate.environmentId !== environmentId) {
          throw new Error(`This migration candidate belongs to ${candidate.environmentId}.`);
        }
        const projectionFingerprint = (projectionBody as { fingerprint: string }).fingerprint;
        const approvalRequest: ReviewRequest = {
          organizationId,
          environmentId,
          projectionFingerprint,
          draft: candidate.draft,
          migrationCandidateId: candidate.candidateId,
        };
        const reviewResponse = await consoleFetch(
          `${consoleConfig.backendUrl}/v1/workflow-reviews`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...approvalRequest,
              migration: {
                fromCapabilityVersionId: candidate.fromCapabilityVersionId,
                toCapabilityVersionId: candidate.toCapabilityVersionId,
              },
            }),
            signal: controller.signal,
          },
        );
        const reviewBody: unknown = await readWorkflowResponseJson(reviewResponse);
        if (!reviewResponse.ok) {
          throw new Error(describeWorkflowFailure(reviewResponse.status, reviewBody));
        }
        setReviewRequest(approvalRequest);
        setReview(reviewBody as WorkflowReview);
        invalidateChecks();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        openedMigrationCandidateId.current = undefined;
        setError(cause instanceof Error ? cause.message : 'Migration review could not be loaded');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [environmentId, locationHash, organizationId]);

  const canDraft = role === 'author' || role === 'admin';
  const currentBuilderValidation =
    builderValidation && review?.workflowVersionId === builderValidation.workflowVersionId
      ? builderValidation
      : undefined;
  const builderHasChanges =
    builderOpened &&
    workflowExecutableKey(manual.document.executable) !==
      (currentBuilderValidation?.executableKey ??
        workflowExecutableKey(createBuilderDocument(reviewRequest?.draft.executable).executable));
  const hasUnvalidatedChanges = Boolean(
    builderHasChanges ||
    (review?.artifact && artifactYaml !== workflowArtifactYaml(review.artifact)),
  );
  const artifactAffordance = review
    ? approvalAffordance(role, review, hasUnvalidatedChanges)
    : undefined;
  const testAffordance = sandboxApprovalAffordance(sandbox.status);
  const affordance =
    !artifactAffordance || role !== 'admin' || hasUnvalidatedChanges || testAffordance.enabled
      ? artifactAffordance
      : testAffordance;

  async function openReview(
    result: ValidatedWorkflowDraft,
    signal?: AbortSignal,
  ): Promise<ReviewRequest> {
    const attemptId = draftAttemptId.current;
    const request: ReviewRequest = {
      organizationId,
      environmentId,
      projectionFingerprint: result.projectionFingerprint,
      draft: result.draft,
    };
    const response = await consoleFetch(`${consoleConfig.backendUrl}/v1/workflow-reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    const body: unknown = await readWorkflowResponseJson(response);
    if (!response.ok) throw new Error(describeWorkflowFailure(response.status, body));
    if (signal?.aborted || draftAttemptId.current !== attemptId) return request;
    setReview(body as WorkflowReview);
    setReviewRequest(request);
    setBuilderValidation(undefined);
    manual.importExecutable(result.draft.executable);
    invalidateChecks();
    return request;
  }

  function closeCapabilityEvidence() {
    const restoreStepId = capabilityDrawer.restoreFocusStepId;
    setCapabilityDrawer(closeCapabilityDrawer(capabilityDrawer));
    if (!restoreStepId) return;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-diagram-step="${restoreStepId}"]`)?.focus();
    });
  }

  function openReferencedCapability(capabilityVersionId: string) {
    setCapabilityDrawer({ capabilityVersionId, restoreFocusStepId: null });
  }

  function invalidateChecks() {
    ++checkAttemptId.current;
    checkAbortController.current?.abort();
    checkAbortController.current = undefined;
    activeCheckUrl.current = undefined;
    setSandbox(emptySandboxState);
  }

  function clearReviewSurfaces() {
    setReview(undefined);
    setReviewRequest(undefined);
    setBuilderValidation(undefined);
    setArtifactYaml('');
    setDiagramPreview({ status: 'hidden' });
    setCapabilityDrawer({ capabilityVersionId: null, restoreFocusStepId: null });
    setEditMessage(undefined);
    setEditError(undefined);
    setApprovalMessage(undefined);
    invalidateChecks();
  }

  function applyDrafting(next: DraftingState) {
    draftAttemptId.current = next.requestId;
    setDrafting(next);
    if (!next.revealEvidence) clearReviewSurfaces();
  }

  function updateEditor(nextEditor: typeof editor) {
    const nextDrafting = editRequest(drafting, nextEditor.text);
    setEditor(nextEditor);
    if (nextDrafting === drafting) return;
    setAiProposal(undefined);
    sessionStorage.removeItem(draftStorageKey);
    draftAttemptId.current = nextDrafting.requestId;
    setDrafting(nextDrafting);
    if (drafting.revealEvidence) clearReviewSurfaces();
  }

  function changeEditorMode(mode: 'ai' | 'builder') {
    if (busy || manual.busy || drafting.phase === 'drafting') return;
    if (mode === 'builder') {
      try {
        const sourceChanged =
          review?.artifact && artifactYaml !== workflowArtifactYaml(review.artifact);
        if (sourceChanged) {
          const artifact = parseWorkflowArtifactYaml(artifactYaml);
          if (!immutableArtifactFieldsMatch(artifact, review.artifact!)) {
            throw new Error('Restore the workflow identity fields before opening Builder.');
          }
          manual.importExecutable(artifact.executable);
        } else if (!builderOpened) {
          manual.importExecutable(reviewRequest?.draft.executable ?? drafting.draft?.executable);
        }
        setBuilderOpened(true);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'The source could not be opened in Builder.',
        );
        return;
      }
    }
    setEditorMode(mode);
  }

  function changeBuilderDocument(next: BuilderDocument) {
    const behaviorChanged =
      workflowExecutableKey(next.executable) !== workflowExecutableKey(manual.document.executable);
    manual.update(next);
    if (!behaviorChanged) return;
    setAiProposal(undefined);
    setApprovalMessage(undefined);
    invalidateChecks();
    if (
      review?.artifact &&
      next.executable &&
      typeof next.executable === 'object' &&
      !Array.isArray(next.executable)
    ) {
      setArtifactYaml(
        workflowArtifactYaml({
          ...review.artifact,
          executable: next.executable as Record<string, unknown>,
        }),
      );
    }
  }

  async function saveBuilder() {
    if (!canDraft || busy) return;
    const result = await manual.save();
    if (!result) return;
    setSavedDraftListVersion((version) => version + 1);
    if (typeof window !== 'undefined') {
      window.location.hash = `#/workflows?${new URLSearchParams({ editorWorkflowId: workflowId })}`;
    }
  }

  async function validateBuilder() {
    if (!canDraft || busy || !builderProjection) return;
    const executableKey = workflowExecutableKey(manual.document.executable);
    const result = await manual.validate(builderProjection);
    if (!result) return;
    setReviewRequest({
      organizationId,
      environmentId,
      projectionFingerprint: builderProjection,
      draft: result.draft,
    });
    setReview(result.review);
    setBuilderValidation({ executableKey, workflowVersionId: result.review.workflowVersionId });
    if (result.draft.irHash !== reviewRequest?.draft.irHash) {
      invalidateChecks();
      setApprovalMessage(undefined);
    }
  }

  async function acceptAiProposal() {
    const proposal = aiProposal;
    if (!proposal?.state.draft || !proposal.state.projectionFingerprint || busy || manual.busy)
      return;
    const current = builderOpened
      ? manual.document.executable
      : createBuilderDocument(reviewRequest?.draft.executable).executable;
    if (workflowExecutableKey(current) !== proposal.baseline || hasUnvalidatedChanges) {
      setAiProposal(undefined);
      setEditError(
        'The workflow changed after this proposal. Ask AI again using the current draft.',
      );
      return;
    }
    setBusy(true);
    setEditError(undefined);
    const controller = beginDraftRequest(drafting);
    try {
      await saveWorkflowCatalogDraft(
        {
          organizationId,
          environmentId,
          workflowId,
          name: workflowName.trim(),
          draft: proposal.state.draft,
        },
        demoTokenForRole(role),
        controller,
      );
      await openReview(
        {
          status: 'validated',
          projectionFingerprint: proposal.state.projectionFingerprint,
          draft: proposal.state.draft,
        },
        controller,
      );
      if (controller.aborted) return;
      setDrafting(proposal.state);
      setAiProposal(undefined);
      sessionStorage.removeItem(draftStorageKey);
    } catch (cause) {
      if (!controller.aborted)
        setEditError(
          cause instanceof Error ? cause.message : 'Could not apply the proposed changes.',
        );
    } finally {
      if (!controller.aborted) setBusy(false);
    }
  }

  async function startOver() {
    if (drafting.phase === 'drafting' && !(await cancelActiveDraft())) return;
    draftAbortController.current?.abort();
    draftAbortController.current = undefined;
    draftCancelFallback.current = undefined;
    activeDraftUrl.current = undefined;
    openedMigrationCandidateId.current = undefined;
    openedCatalogWorkflowVersion.current = undefined;
    const fresh = {
      ...createDraftingState(sampleDemoWorkflowRequest),
      requestId: draftAttemptId.current + 1,
    };
    draftAttemptId.current = fresh.requestId;

    sessionStorage.removeItem(draftStorageKey);
    setEditor(createRequestEditor({ text: sampleDemoWorkflowRequest }));
    setDrafting(fresh);
    setClarificationAnswer('');
    setRevisionPrompt('');
    setWorkflowName('');
    setWorkflowId(`workflow_${crypto.randomUUID()}`);
    setBuilderOpened(false);
    setEditorMode('ai');
    setAiProposal(undefined);
    clearReviewSurfaces();
    setDraftProgress(undefined);
    setDraftConnectionLost(false);
    setError(undefined);
    setBusy(false);
    if (locationHash.includes('?')) window.location.hash = '#/workflows';
  }

  function beginDraftRequest(fallback: DraftingState) {
    draftAbortController.current?.abort();
    const controller = new AbortController();
    draftAbortController.current = controller;
    draftCancelFallback.current = fallback;
    return controller.signal;
  }

  function finishDraftRequest(requestId: number) {
    if (draftAttemptId.current !== requestId) return;
    draftAbortController.current = undefined;
    draftCancelFallback.current = undefined;
    setBusy(false);
  }

  async function cancelActiveDraft() {
    if (drafting.phase !== 'drafting') return false;
    const cancellingAttempt = draftAttemptId.current;
    draftAbortController.current?.abort();
    const saved = sessionStorage.getItem(draftStorageKey);
    if (saved)
      sessionStorage.setItem(
        draftStorageKey,
        JSON.stringify({ ...JSON.parse(saved), cancelRequested: true }),
      );
    if (activeDraftUrl.current) {
      try {
        const response = await consoleFetch(activeDraftUrl.current, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${demoTokenForRole(role)}` },
        });
        if (!response.ok) throw new Error('Cancellation was not confirmed.');
        const progress: DraftRequestProgress = await response.json();
        if (draftAttemptId.current !== cancellingAttempt) return false;
        setDraftProgress((current) =>
          drafting.sandboxRepair ? continueDraftProgress(current, progress) : progress,
        );
      } catch {
        setError('Could not confirm cancellation. Reconnect and try cancelling again.');
        return false;
      }
    }
    draftAbortController.current?.abort();
    draftAbortController.current = undefined;
    const fallback = draftCancelFallback.current ?? createDraftingState(prompt);
    draftCancelFallback.current = undefined;
    const cancelled = cancelDraft(drafting, fallback);
    draftAttemptId.current = cancelled.requestId;
    setDrafting(cancelled);
    setBusy(false);
    setError(undefined);
    return true;
  }

  async function postDraft(
    state: DraftingState,
    signal: AbortSignal,
    recovered?: { url: string; workflowName: string; workflowId: string },
  ) {
    const revisionBaseline = state.revisionContext
      ? workflowExecutableKey(
          builderOpened
            ? manual.document.executable
            : createBuilderDocument(state.revisionContext.draft.executable).executable,
        )
      : undefined;
    const body = draftRequestBody(
      { organizationId, environmentId, workflowVersionId: nextWorkflowVersionId() },
      state,
      editor,
    );
    const url =
      recovered?.url ??
      `${consoleConfig.backendUrl}/v1/draft-requests/${crypto.randomUUID()}?${new URLSearchParams({ organizationId, environmentId })}`;
    activeDraftUrl.current = url;
    if (!recovered) {
      setDraftProgress((current) => {
        if (!state.sandboxRepair || !current) return undefined;
        const { finishedAt: _finishedAt, result: _result, error: _error, ...previous } = current;
        return { ...previous, status: 'running', stage: 'repairing' };
      });
      sessionStorage.setItem(
        draftStorageKey,
        JSON.stringify({ url, state, workflowName, workflowId }),
      );
    }
    const result = await followDraftRequest({
      url,
      token: demoTokenForRole(role),
      signal,
      ...(recovered ? {} : { body }),
      onProgress: (progress) => {
        if (draftAttemptId.current === state.requestId) {
          setDraftProgress((current) =>
            state.sandboxRepair ? continueDraftProgress(current, progress) : progress,
          );
        }
      },
      onConnectionChange: (lost) => {
        if (draftAttemptId.current === state.requestId) setDraftConnectionLost(lost);
      },
    });
    signal.throwIfAborted();
    if (draftAttemptId.current !== state.requestId) return;
    const payload = result.body;
    if (!payload || typeof payload !== 'object' || !('status' in payload)) {
      throw new Error(describeWorkflowFailure(result.httpStatus, payload));
    }
    if (draftAttemptId.current !== state.requestId) return;
    const received = receiveDraftResponse(state, state.requestId, payload as DraftResponse);
    if (received.phase === 'drafting') {
      throw new Error(describeWorkflowFailure(result.httpStatus, payload));
    }
    if (state.revisionContext && received.revealEvidence && received.draft) {
      setAiProposal({
        state: received,
        baseline: revisionBaseline!,
      });
      setDrafting({
        ...(draftCancelFallback.current ?? drafting),
        requestId: state.requestId,
        phase: 'validated',
      });
      sessionStorage.removeItem(draftStorageKey);
      return;
    }
    if (state.sandboxRepair) setDrafting(received);
    else applyDrafting(received);
    if (
      received.revealEvidence &&
      received.projectionFingerprint &&
      received.draft &&
      draftAttemptId.current === state.requestId
    ) {
      await openReview(
        {
          status: 'validated',
          projectionFingerprint: received.projectionFingerprint,
          draft: received.draft,
        },
        signal,
      );
      if (signal.aborted || draftAttemptId.current !== state.requestId) return;
      const savedName = recovered?.workflowName ?? workflowName;
      const savedId = recovered?.workflowId ?? workflowId;
      if (savedName.trim()) {
        await saveWorkflowCatalogDraft(
          {
            organizationId,
            environmentId,
            workflowId: savedId,
            name: savedName.trim(),
            draft: received.draft,
          },
          demoTokenForRole(role),
          signal,
        );
      }
    }
  }

  async function createDraft() {
    if (!canDraft || !workflowName.trim() || !prompt.trim() || drafting.phase === 'drafting')
      return;
    const submitted = submitDraft(drafting, prompt);
    const signal = beginDraftRequest(createDraftingState(prompt));
    draftAttemptId.current = submitted.requestId;

    applyDrafting(submitted);
    setClarificationAnswer('');
    setBusy(true);
    setError(undefined);
    try {
      await postDraft(submitted, signal);
    } catch (cause) {
      if (signal.aborted) return;
      if (draftAttemptId.current === submitted.requestId) {
        setError(cause instanceof Error ? cause.message : 'Workflow drafting failed');
        setDrafting((current) =>
          current.requestId === submitted.requestId
            ? current.draft
              ? current
              : { ...current, phase: 'editing', revealEvidence: false, revealValidated: false }
            : current,
        );
      }
    } finally {
      if (!signal.aborted) finishDraftRequest(submitted.requestId);
    }
  }

  async function reviseDraftWithPrompt(
    prompt = revisionPrompt,
    options: { ignoreUnsaved?: boolean } = {},
  ) {
    const request = prompt.trim();
    if (
      !canDraft ||
      !request ||
      !reviewRequest ||
      !review?.artifact ||
      (!options.ignoreUnsaved && hasUnvalidatedChanges) ||
      busy ||
      manual.busy
    )
      return;
    setAiProposal(undefined);
    const previousState = drafting;
    const submitted = submitDraftRevision(drafting, request, {
      previousRequest: drafting.clarifiedRequest ?? drafting.request,
      draft: reviewRequest.draft,
    });
    const signal = beginDraftRequest(previousState);
    draftAttemptId.current = submitted.requestId;

    setDrafting(submitted);
    setBusy(true);
    setError(undefined);
    setEditError(undefined);
    setEditMessage(undefined);
    try {
      await postDraft(submitted, signal);
      if (draftAttemptId.current === submitted.requestId) setRevisionPrompt('');
    } catch (cause) {
      if (signal.aborted) return;
      if (draftAttemptId.current === submitted.requestId) {
        setError(cause instanceof Error ? cause.message : 'Workflow drafting failed');
        setDrafting((current) => (current.draft ? current : previousState));
      }
    } finally {
      if (!signal.aborted) finishDraftRequest(submitted.requestId);
    }
  }

  async function submitAnswer(answer = clarificationAnswer) {
    if (!canDraft || !answer.trim()) return;
    const normalizedAnswer = answer.trim();
    const environmentAction = environmentActionForAnswer(drafting, normalizedAnswer);
    if (environmentAction) {
      setEnvironmentId(environmentAction.environmentId);
      applyDrafting(reviseRequest(drafting));
      setClarificationAnswer('');
      return;
    }
    const answering = submitClarificationAnswer(drafting, normalizedAnswer);
    if (answering.phase !== 'drafting' || !answering.continuation || !answering.answer) return;
    const signal = beginDraftRequest(drafting);
    draftAttemptId.current = answering.requestId;
    applyDrafting(answering);
    setBusy(true);
    setError(undefined);
    try {
      await postDraft(answering, signal);
      if (draftAttemptId.current === answering.requestId) setClarificationAnswer('');
    } catch (cause) {
      if (signal.aborted) return;
      if (draftAttemptId.current === answering.requestId) {
        setError(cause instanceof Error ? cause.message : 'Workflow drafting failed');
        setDrafting((current) =>
          current.requestId === answering.requestId
            ? current.draft
              ? current
              : {
                  ...current,
                  phase: 'clarification_required',
                  revealEvidence: false,
                  revealValidated: false,
                }
            : current,
        );
      }
    } finally {
      if (!signal.aborted) finishDraftRequest(answering.requestId);
    }
  }

  async function approve() {
    if (!reviewRequest || !affordance?.enabled || busy || manual.busy) return;
    if (currentBuilderValidation && !workflowName.trim()) {
      setError('Name this workflow before approving it.');
      return;
    }
    const signal = beginDraftRequest(drafting);
    const attempt = draftAttemptId.current;
    setBusy(true);
    setError(undefined);
    try {
      if (currentBuilderValidation) {
        await saveWorkflowCatalogDraft(
          {
            organizationId,
            environmentId,
            workflowId,
            name: workflowName.trim(),
            draft: reviewRequest.draft,
          },
          demoTokenForRole(role),
          signal,
        );
        if (signal.aborted || attempt !== draftAttemptId.current) return;
      }
      const response = await consoleFetch(`${consoleConfig.backendUrl}/v1/workflow-approvals`, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${demoTokenForRole(role)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(reviewRequest),
      });
      const body: unknown = await readWorkflowResponseJson(response);
      if (signal.aborted || attempt !== draftAttemptId.current) return;
      if (!response.ok) throw new Error(describeWorkflowFailure(response.status, body));
      setApprovalMessage(
        reviewRequest.migrationCandidateId
          ? 'Approved this version.'
          : 'Approved this version. New runs use it; runs that already started keep their original version.',
      );
    } catch (cause) {
      if (!signal.aborted && attempt === draftAttemptId.current)
        setError(cause instanceof Error ? cause.message : 'Workflow approval failed');
    } finally {
      if (!signal.aborted) finishDraftRequest(attempt);
    }
  }

  async function validateSource() {
    if (!review?.workflowVersionId || !reviewRequest || !canDraft || busy || manual.busy) return;
    const signal = beginDraftRequest(drafting);
    const attempt = draftAttemptId.current;
    setBusy(true);
    setEditError(undefined);
    setEditMessage(undefined);
    setApprovalMessage(undefined);
    try {
      const artifact = parseWorkflowArtifactYaml(artifactYaml);
      if (!review.artifact || !immutableArtifactFieldsMatch(artifact, review.artifact)) {
        throw new Error(
          'Workflow identity fields are read-only. Restore them and edit only the executable section.',
        );
      }
      const response = await consoleFetch(`${consoleConfig.backendUrl}/v1/workflow-edits`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          environmentId,
          projectionFingerprint: reviewRequest.projectionFingerprint,
          sourceWorkflowVersionId: review.workflowVersionId,
          executable: artifact.executable,
        }),
      });
      const body: unknown = await readWorkflowResponseJson(response);
      if (signal.aborted || attempt !== draftAttemptId.current) return;
      if (!response.ok) throw new Error(describeWorkflowFailure(response.status, body));
      const result = body as { draft: Record<string, unknown>; review: WorkflowReview };
      setReviewRequest({
        organizationId,
        environmentId,
        projectionFingerprint: reviewRequest.projectionFingerprint,
        draft: result.draft,
      });
      setReview(result.review);
      manual.importExecutable(result.draft.executable);
      setBuilderValidation({
        executableKey: workflowExecutableKey(
          createBuilderDocument(result.draft.executable).executable,
        ),
        workflowVersionId: result.review.workflowVersionId,
      });
      invalidateChecks();
      setEditMessage('Definition validated. Use Save draft in Builder to save your changes.');
    } catch (cause) {
      if (!signal.aborted && attempt === draftAttemptId.current)
        setEditError(
          cause instanceof Error ? cause.message : 'Workflow definition could not be validated',
        );
    } finally {
      if (!signal.aborted) finishDraftRequest(attempt);
    }
  }

  async function runSandboxTests(
    request = reviewRequest,
  ): Promise<WorkflowSandboxResult | undefined> {
    if (!request || !canDraft) return;
    if (hasUnvalidatedChanges) return;
    const attemptId = draftAttemptId.current;
    const checkId = ++checkAttemptId.current;
    const controller = new AbortController();
    checkAbortController.current?.abort();
    checkAbortController.current = controller;
    const url = new URL(
      `/v1/workflow-sandbox-test-requests/${crypto.randomUUID()}`,
      consoleConfig.backendUrl,
    );
    url.searchParams.set('organizationId', organizationId);
    url.searchParams.set('environmentId', environmentId);
    activeCheckUrl.current = url.toString();
    const isCurrent = () =>
      !controller.signal.aborted &&
      checkAttemptId.current === checkId &&
      draftAttemptId.current === attemptId;
    setSandbox({ status: 'running' });
    setApprovalMessage(undefined);
    try {
      const state = await followWorkflowCheckRequest<WorkflowSandboxResult>({
        url: url.toString(),
        token: demoTokenForRole(role),
        signal: controller.signal,
        body: {
          organizationId,
          environmentId,
          draft: request.draft,
        },
        onProgress: (progress: WorkflowCheckRequestState<WorkflowSandboxResult>) => {
          if (!isCurrent()) return;
          setSandbox({
            status: progress.status,
            ...(progress.status === 'running' && progress.progress
              ? { progress: progress.progress }
              : {}),
            ...(progress.result ? { result: progress.result } : {}),
            ...(progress.error ? { error: progress.error } : {}),
          });
        },
      });
      if (!isCurrent()) return;
      if (!state.result) return;
      const refreshedReview = await refreshReviewAfterSandboxRun(state.status, async () => {
        const reviewResponse = await consoleFetch(
          `${consoleConfig.backendUrl}/v1/workflow-reviews`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...request,
              ...(review?.migration
                ? {
                    migration: {
                      fromCapabilityVersionId: review.migration.fromCapabilityVersionId,
                      toCapabilityVersionId: review.migration.toCapabilityVersionId,
                    },
                  }
                : {}),
            }),
          },
        );
        const reviewBody: unknown = await readWorkflowResponseJson(reviewResponse);
        if (!reviewResponse.ok) {
          throw new Error(describeWorkflowFailure(reviewResponse.status, reviewBody));
        }
        return reviewBody as WorkflowReview;
      });
      if (!isCurrent()) return;
      if (refreshedReview) setReview(refreshedReview);
      return state.result;
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (!isCurrent()) return;
      setSandbox({
        status: 'failed',
        error: cause instanceof Error ? cause.message : 'Sandbox tests could not run',
      });
      return undefined;
    } finally {
      if (checkAttemptId.current === checkId) {
        checkAbortController.current = undefined;
        activeCheckUrl.current = undefined;
      }
    }
  }

  async function cancelActiveChecks() {
    if (sandbox.status !== 'running' || !activeCheckUrl.current) return;
    const url = activeCheckUrl.current;
    const checkId = ++checkAttemptId.current;
    checkAbortController.current?.abort();
    const controller = new AbortController();
    checkAbortController.current = controller;
    const isCurrent = () => !controller.signal.aborted && checkAttemptId.current === checkId;
    try {
      const response = await consoleFetch(url, {
        method: 'DELETE',
        signal: controller.signal,
        headers: { authorization: `Bearer ${demoTokenForRole(role)}` },
      });
      const body: unknown = await readWorkflowResponseJson(response);
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(describeWorkflowFailure(response.status, body));
      const state = body as WorkflowCheckRequestState<WorkflowSandboxResult>;
      setSandbox({
        status: state.status,
        ...(state.status === 'running' && state.progress ? { progress: state.progress } : {}),
        ...(state.result ? { result: state.result } : {}),
        ...(state.error ? { error: state.error } : {}),
      });
    } catch (cause) {
      if (!isCurrent()) return;
      setSandbox({
        status: 'failed',
        error: cause instanceof Error ? cause.message : 'Checks could not be cancelled.',
      });
    } finally {
      if (isCurrent()) {
        activeCheckUrl.current = undefined;
        checkAbortController.current = undefined;
      }
    }
  }

  const referenceIdentities =
    editor.index?.references.map((reference) => ({
      capabilityVersionId: reference.capabilityVersionId,
      kind: reference.identity.kind,
      serviceId: reference.identity.serviceId,
      operationId: reference.identity.operationId,
      owner: reference.owner,
      ...(reference.observation ? { observation: reference.observation } : {}),
    })) ?? [];
  const hasWorkToReset = Boolean(
    hasBuilderWork ||
    workflowName ||
    prompt !== sampleDemoWorkflowRequest ||
    drafting.phase !== 'editing' ||
    draftProgress ||
    error ||
    diagramPreview.status !== 'hidden',
  );
  const checkFailure =
    sandbox.status === 'failed' && sandbox.result && drafting.phase !== 'drafting'
      ? explainCheckFailure(sandbox.result.tests, {
          identities: referenceIdentities,
          stepName: humanStepName,
        })
      : undefined;

  function editSource(yaml: string) {
    if (yaml !== artifactYaml) invalidateChecks();
    setArtifactYaml(yaml);
    setEditMessage(undefined);
    setEditError(undefined);
    setApprovalMessage(undefined);
  }
  function openNode(node: Parameters<typeof openCapabilityDrawer>[0]) {
    setCapabilityDrawer(openCapabilityDrawer(node));
  }
  function selectCapabilityVersion(capabilityVersionId: string) {
    setCapabilityDrawer((current) => ({ ...current, capabilityVersionId }));
  }
  function openSavedDraft(selectedWorkflowId: string) {
    if (busy || manual.busy) return;
    if (selectedWorkflowId === workflowId) {
      setBuilderOpened(true);
      setEditorMode('builder');
      manual.reload();
    } else {
      window.location.hash = `#/workflows?${new URLSearchParams({ editorWorkflowId: selectedWorkflowId })}`;
    }
  }
  function refreshSavedDrafts() {
    setSavedDraftListVersion((version) => version + 1);
  }
  function keepCurrentWorkflow() {
    setAiProposal(undefined);
  }
  function renameWorkflow(name: string) {
    setWorkflowName(name);
  }
  function changeAnswer(answer: string) {
    setClarificationAnswer(answer);
  }
  function changeRevisionPrompt(prompt: string) {
    setRevisionPrompt(prompt);
  }

  return {
    state: {
      draftProgress,
      drafting,
      canDraft,
      editor,
      error,
      busy,
      manual: {
        document: manual.document,
        revision: manual.revision,
        busy: manual.busy,
        operation: manual.operation,
        error: manual.error,
        message: manual.message,
        issues: manual.issues,
        dirty: manual.dirty,
      },
      hasWorkToReset,
      workflowName,
      editorMode,
      savedManualDrafts,
      savedDraftListStatus,
      workflowId,
      builderOpened,
      reviewFromBuilder: Boolean(currentBuilderValidation),
      role,
      builderProjection,
      builderLoadError,
      organizationId,
      environmentId,
      builderCapabilities,
      diagramPreview,
      capabilityDrawer,
      checkFailure,
      review,
      referenceIdentities,
      draftConnectionLost,
      clarificationAnswer,
      aiProposal,
      reviewRequest,
      hasUnvalidatedChanges,
      editError,
      editMessage,
      revisionPrompt,
      artifactYaml,
      affordance,
      approvalMessage,
      sandbox,
    },
    commands: {
      createDraft,
      startOver,
      updateEditor,
      renameWorkflow,
      openReferencedCapability,
      changeEditorMode,
      openSavedDraft,
      saveBuilder,
      validateBuilder,
      refreshSavedDrafts,
      changeBuilderDocument,
      closeCapabilityEvidence,
      openNode,
      cancelActiveDraft,
      reviseDraftWithPrompt,
      changeAnswer,
      submitAnswer,
      acceptAiProposal,
      keepCurrentWorkflow,
      changeRevisionPrompt,
      validateSource,
      editSource,
      approve,
      cancelActiveChecks,
      runSandboxTests,
      selectCapabilityVersion,
    },
  };
}
