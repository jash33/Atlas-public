import { useCallback, useEffect, useState } from 'react';

import type { DemoRole } from '../shell/session.js';
import { decideAccessRequest, loadAccessRequests, type AccessRequest } from './access-requests.js';

export function AccessRequestCard({
  request,
  onDecision,
  pending = false,
}: {
  request: AccessRequest;
  onDecision: (decision: 'approve' | 'reject', role: DemoRole) => void;
  pending?: boolean;
}) {
  const [role, setRole] = useState<DemoRole>('author');
  return (
    <article className="access-request-card">
      <header>
        <strong>{request.displayName}</strong>
        <span>{request.status}</span>
      </header>
      {request.email && <p>{request.email}</p>}
      <p>
        Request reference: <code>{request.id}</code>
      </p>
      {request.status === 'pending' && (
        <>
          <label>
            Access role
            <select
              aria-label={`Access role for ${request.displayName}`}
              value={role}
              disabled={pending}
              onChange={(event) => setRole(event.target.value as DemoRole)}
            >
              <option value="author">Author</option>
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <p>
            {role === 'admin'
              ? 'Admins can approve access and manage organization settings.'
              : role === 'operator'
                ? 'Operators can manage workflow runs and repairs.'
                : 'Authors can create, test, and start workflows.'}
          </p>
          <div className="access-request-actions">
            <button type="button" disabled={pending} onClick={() => onDecision('approve', role)}>
              Approve as {role}
            </button>
            <button type="button" disabled={pending} onClick={() => onDecision('reject', role)}>
              Reject request
            </button>
          </div>
        </>
      )}
    </article>
  );
}

export function AccessRequests() {
  const [requests, setRequests] = useState<AccessRequest[]>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setError(undefined);
    try {
      const next = await loadAccessRequests(signal);
      if (!signal?.aborted) setRequests(next);
    } catch (failure) {
      if (!signal?.aborted)
        setError(
          failure instanceof Error ? failure.message : 'Access requests could not be loaded.',
        );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  const decide = async (request: AccessRequest, decision: 'approve' | 'reject', role: DemoRole) => {
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await decideAccessRequest(request.id, decision, role);
      setRequests((current) =>
        current?.map((item) =>
          item.id === request.id
            ? { ...item, status: decision === 'approve' ? 'approved' : 'rejected' }
            : item,
        ),
      );
      setMessage(
        decision === 'approve'
          ? `${request.displayName} can now sign in as ${role}.`
          : `Access request rejected for ${request.displayName}.`,
      );
      await refresh();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The access request could not be updated.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="access-requests" aria-labelledby="access-requests-title">
      <header>
        <div>
          <h2 id="access-requests-title">Access requests</h2>
          <p>Review accounts verified by your organization's sign-in provider.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh requests
        </button>
      </header>
      <p>Confirm the person should have access before choosing a role and approving.</p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!requests && !error && <p role="status">Loading access requests...</p>}
      {requests?.length === 0 && <p>No access requests to review.</p>}
      {requests?.map((request) => (
        <AccessRequestCard
          key={request.id}
          request={request}
          pending={busy}
          onDecision={(decision, role) => void decide(request, decision, role)}
        />
      ))}
    </section>
  );
}
