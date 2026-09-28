import { blockedOutcomeCopy } from './conversation-copy.js';

export function BlockedOutcome({
  detail,
  diagnostics,
  identities,
  phase,
  reason,
}: {
  detail?: string;
  diagnostics?: Array<{ code: string; path: string; message: string }>;
  identities?: readonly { operationId?: string; serviceId?: string }[];
  phase: 'unsupported' | 'manual_review';
  reason?: string;
}) {
  const copy = blockedOutcomeCopy({
    ...(detail ? { detail } : {}),
    ...(identities ? { identities } : {}),
    phase,
    ...(reason ? { reason } : {}),
  });
  const hasTechnical =
    Boolean(copy.technicalReason) ||
    Boolean(copy.technicalDetail) ||
    Boolean(diagnostics && diagnostics.length > 0);

  return (
    <div className="wf-blocked">
      <p>{copy.sentence}</p>
      {hasTechnical && (
        <details className="wf-clarification-details">
          <summary>Technical details</summary>
          {copy.technicalReason && (
            <p>
              <code>{copy.technicalReason}</code>
            </p>
          )}
          {copy.technicalDetail && <p>{copy.technicalDetail}</p>}
          {diagnostics && diagnostics.length > 0 && (
            <ul className="wf-inline-diagnostics">
              {diagnostics.map((diagnostic) => (
                <li key={`${diagnostic.code}:${diagnostic.path}`}>
                  <code>{diagnostic.code}</code> · {diagnostic.path} · {diagnostic.message}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}
