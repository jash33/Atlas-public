import type { ObjectSchema } from '@atlas/workflow-ir';
import { useEffect, useRef, useState } from 'react';

import { demoTokenForRole } from '../config.js';
import { runDetailHash } from '../shell/router.js';
import { useConsoleSession } from '../shell/session.js';
import { loadApiRunReadiness, startApiRun } from './data.js';

export interface ApiRunReadiness {
  workflowId: string;
  name: string;
  ready: boolean;
  workflowVersionId: string | null;
  artifactId: string | null;
  targetWorkerId: string | null;
  runCommandPublicKey: string | null;
  inputSchema: ObjectSchema | null;
  blockers: string[];
  warnings?: string[];
}

export interface RunLauncherMessage {
  tone: 'error' | 'success' | 'status';
  text: string;
}

const rehearsalScenarios = [
  { label: 'Use happy-path input', paymentId: 'payment_demo_001' },
  { label: 'Use retry rehearsal input', paymentId: 'payment_retry_demo_001' },
  { label: 'Use repair rehearsal input', paymentId: 'payment_repair_demo_001' },
] as const;

export const sampleDemoWorkflowName = 'Invoice drift demo workflow';

export function RunLauncher() {
  const { organizationId, environmentId, role } = useConsoleSession();
  const [paymentId, setPaymentId] = useState('payment_demo_001');
  const [readiness, setReadiness] = useState<ApiRunReadiness>();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<RunLauncherMessage>();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const canStart = role === 'author' || role === 'admin';

  useEffect(() => {
    if (!canStart) {
      setReadiness(undefined);
      setLoading(false);
      setMessage(undefined);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setMessage(undefined);
    void loadApiRunReadiness(
      {
        organizationId,
        environmentId,
        bearerToken: demoTokenForRole(role),
        workflowName: sampleDemoWorkflowName,
      },
      controller.signal,
    )
      .then(setReadiness)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setReadiness(undefined);
          setMessage({
            tone: 'error',
            text: error instanceof Error ? error.message : 'Run readiness could not be loaded.',
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canStart, environmentId, organizationId, role]);

  async function start() {
    if (!readiness || submittingRef.current) return;
    const normalizedPaymentId = paymentId.trim();
    if (!normalizedPaymentId) {
      setMessage({ tone: 'error', text: 'Enter a payment ID before starting the run.' });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setMessage({ tone: 'status', text: 'Encrypting input for the customer worker…' });
    try {
      const result = await startApiRun(
        { organizationId, environmentId, bearerToken: demoTokenForRole(role) },
        readiness,
        normalizedPaymentId,
      );
      setMessage({
        tone: 'success',
        text:
          result.intakeStatus === 'duplicate'
            ? `Reused Temporal run ${result.workflowRunId}. Opening its trace…`
            : `Started Temporal run ${result.workflowRunId}. Opening its trace…`,
      });
      window.location.hash = runDetailHash(result.workflowRunId!);
      window.location.reload();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Run could not be started.',
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <section className="run-launcher run-launcher-loading" aria-live="polite">
        Checking whether the active workflow can start…
      </section>
    );
  }
  if (!canStart) {
    return (
      <section className="run-launcher run-launcher-blocked" aria-label="Start workflow run">
        <p>Switch to Author or Admin to start a workflow run.</p>
      </section>
    );
  }
  if (!readiness) {
    return (
      <section className="run-launcher run-launcher-blocked" aria-label="Run unavailable">
        {message && (
          <p aria-live="polite" className="wf-error">
            {message.text}
          </p>
        )}
      </section>
    );
  }
  return (
    <RunLauncherView
      canStart={canStart}
      message={message}
      onPaymentIdChange={(value) => {
        setPaymentId(value);
        setMessage(undefined);
      }}
      onScenarioSelect={(value) => {
        setPaymentId(value);
        setMessage(undefined);
      }}
      onStart={() => void start()}
      paymentId={paymentId}
      readiness={readiness}
      submitting={submitting}
    />
  );
}

export function RunLauncherView({
  canStart,
  message,
  onPaymentIdChange,
  onScenarioSelect,
  onStart,
  paymentId,
  readiness,
  submitting,
}: {
  canStart: boolean;
  message: RunLauncherMessage | undefined;
  onPaymentIdChange: (paymentId: string) => void;
  onScenarioSelect: (paymentId: string) => void;
  onStart: () => void;
  paymentId: string;
  readiness: ApiRunReadiness;
  submitting: boolean;
}) {
  if (!canStart) {
    return (
      <section className="run-launcher run-launcher-blocked" aria-label="Start workflow run">
        <p>Switch to Author or Admin to start a workflow run.</p>
      </section>
    );
  }

  if (!readiness.ready) {
    return (
      <section className="run-launcher run-launcher-blocked" aria-label="Run unavailable">
        <strong>Run unavailable</strong>
        {readiness.blockers.map((blocker) => (
          <p className="wf-error" key={blocker}>
            {blocker}
          </p>
        ))}
      </section>
    );
  }

  return (
    <section className="run-launcher" aria-label="Start workflow run">
      <header>
        <div>
          <small>Active and runnable</small>
          <h2>Start a deterministic scenario</h2>
          <p>
            Atlas sends encrypted input through the backend and opens the durable run after the
            customer worker accepts it.
          </p>
        </div>
        <dl>
          <div>
            <dt>Workflow</dt>
            <dd>{readiness.name}</dd>
          </div>
          <div>
            <dt>Active version</dt>
            <dd>
              <code>{readiness.workflowVersionId}</code>
            </dd>
          </div>
        </dl>
      </header>
      <div className="run-launcher-scenarios" role="group" aria-label="Rehearsal inputs">
        {rehearsalScenarios.map((scenario) => (
          <button
            aria-pressed={paymentId === scenario.paymentId}
            disabled={submitting}
            key={scenario.paymentId}
            onClick={() => onScenarioSelect(scenario.paymentId)}
            type="button"
          >
            <span>{scenario.label}</span>
            <code>{scenario.paymentId}</code>
          </button>
        ))}
      </div>
      <div className="run-launcher-form">
        <label>
          <span>Workflow input · payment ID</span>
          <input
            disabled={submitting}
            onChange={(event) => onPaymentIdChange(event.target.value)}
            required
            value={paymentId}
          />
        </label>
        <button
          className="wf-action"
          disabled={submitting || paymentId.trim().length === 0}
          onClick={onStart}
          type="button"
        >
          {submitting ? 'Starting on Temporal…' : 'Start on Temporal'}
        </button>
      </div>
      {readiness.warnings?.map((warning) => (
        <p className="wf-question" key={warning}>
          {warning}
        </p>
      ))}
      {message && (
        <p
          aria-live="polite"
          className={
            message.tone === 'error'
              ? 'wf-error'
              : message.tone === 'success'
                ? 'wf-approved'
                : 'run-message'
          }
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
