import { useEffect, useRef, useState } from 'react';

import { createBuilderDocument, type BuilderDocument } from './builder-model.js';
import {
  loadManualWorkflow,
  ManualWorkflowValidationError,
  mergeBuilderExecutable,
  saveManualWorkflow,
  validateManualWorkflow,
  workflowExecutableKey,
  type ManualWorkflowScope,
} from './manual-workflow.js';

export function useManualWorkflow(input: {
  scope: ManualWorkflowScope;
  enabled: boolean;
  preferSaved: boolean;
  token: string;
  name: string;
  executable: unknown;
  onLoadName: (name: string) => void;
}) {
  const scopeKey = `${input.scope.organizationId}:${input.scope.environmentId}:${input.scope.workflowId}`;
  const [document, setDocument] = useState(() => createBuilderDocument(input.executable));
  const [revision, setRevision] = useState<number | null>(null);
  const [savedKey, setSavedKey] = useState('');
  const [operation, setOperation] = useState<'loading' | 'saving' | 'validating'>();
  const busy = operation !== undefined;
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [issues, setIssues] = useState<Array<{ stepId?: string; message: string }>>([]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const currentInput = useRef(input);
  currentInput.current = input;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const documentRef = useRef(document);
  documentRef.current = document;
  const changeId = useRef(0);
  const edited = useRef(false);
  const explicitReload = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const loadedScope = useRef<string | undefined>(undefined);

  useEffect(() => {
    request.current?.abort();
    loadedScope.current = undefined;
    changeId.current += 1;
    edited.current = false;
    explicitReload.current = false;
    setDocument(createBuilderDocument(currentInput.current.executable));
    setRevision(null);
    setSavedKey('');
    setOperation(undefined);
    setError(undefined);
    setMessage(undefined);
    setIssues([]);
    return () => request.current?.abort();
  }, [scopeKey]);

  useEffect(() => {
    if (!input.enabled || loadedScope.current === `${scopeKey}:${loadAttempt}`) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setOperation('loading');
    setError(undefined);
    const attempt = changeId.current;
    void loadManualWorkflow(input.scope, controller.signal, input.token)
      .then((saved) => {
        if (
          controller.signal.aborted ||
          currentScope.current !== scopeKey ||
          changeId.current !== attempt
        )
          return;
        loadedScope.current = `${scopeKey}:${loadAttempt}`;
        if (!saved) return;
        setRevision(saved.revision);
        setSavedKey(workflowExecutableKey({ name: saved.name, document: saved.document }));
        if (!edited.current && (currentInput.current.preferSaved || explicitReload.current)) {
          setDocument(saved.document);
          currentInput.current.onLoadName(saved.name);
          setMessage('Loaded your saved working draft.');
        }
        explicitReload.current = false;
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && currentScope.current === scopeKey) {
          setError(cause instanceof Error ? cause.message : 'Could not load the working draft.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && currentScope.current === scopeKey)
          setOperation(undefined);
      });
    return () => controller.abort();
    // Load only when entering the builder or explicitly reloading a saved draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.enabled, scopeKey, loadAttempt]);

  function update(next: BuilderDocument) {
    changeId.current += 1;
    edited.current = true;
    documentRef.current = next;
    setDocument(next);
    setMessage(undefined);
    setIssues([]);
  }

  function importExecutable(executable: unknown) {
    update(mergeBuilderExecutable(documentRef.current, executable));
  }

  async function save() {
    if (busy) return undefined;
    if (!input.name.trim()) {
      setError('Name this workflow before saving it.');
      return undefined;
    }
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const savedDocument = documentRef.current;
    setOperation('saving');
    setError(undefined);
    setMessage(undefined);
    setIssues([]);
    try {
      const saved = await saveManualWorkflow(
        input.scope,
        {
          name: input.name.trim(),
          expectedRevision: revision,
          document: savedDocument,
        },
        input.token,
        controller.signal,
      );
      if (controller.signal.aborted || currentScope.current !== scopeKey) return undefined;
      setRevision(saved.revision);
      setSavedKey(workflowExecutableKey({ name: saved.name, document: saved.document }));
      setMessage('Working draft saved.');
      return saved;
    } catch (cause) {
      if (!controller.signal.aborted && currentScope.current === scopeKey) {
        if (cause instanceof ManualWorkflowValidationError) setIssues(cause.issues);
        setError(cause instanceof Error ? cause.message : 'Could not save the working draft.');
      }
      return undefined;
    } finally {
      if (!controller.signal.aborted && currentScope.current === scopeKey) setOperation(undefined);
    }
  }

  async function validate(projectionFingerprint: string) {
    if (busy) return undefined;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const attempt = changeId.current;
    const isCurrent = () =>
      !controller.signal.aborted &&
      currentScope.current === scopeKey &&
      changeId.current === attempt;
    setOperation('validating');
    setError(undefined);
    setMessage(undefined);
    setIssues([]);
    try {
      const result = await validateManualWorkflow(
        input.scope,
        { document: documentRef.current, projectionFingerprint },
        input.token,
        controller.signal,
      );
      if (!isCurrent()) return undefined;
      setMessage('Validation completed. Review the results below.');
      return result;
    } catch (cause) {
      if (isCurrent()) {
        if (cause instanceof ManualWorkflowValidationError) setIssues(cause.issues);
        setError(cause instanceof Error ? cause.message : 'Could not validate the workflow.');
      }
      return undefined;
    } finally {
      if (!controller.signal.aborted && currentScope.current === scopeKey) setOperation(undefined);
    }
  }

  return {
    document,
    revision,
    busy,
    operation,
    error,
    message,
    issues,
    dirty: workflowExecutableKey({ name: input.name.trim(), document }) !== savedKey,
    update,
    importExecutable,
    save,
    validate,
    reload: () => {
      edited.current = false;
      explicitReload.current = true;
      setLoadAttempt((attempt) => attempt + 1);
    },
  };
}
