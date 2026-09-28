import { useState } from 'react';
import { deleteCapability } from './data.js';

export function DeleteCapability({
  organizationId,
  environmentId,
  capabilityIdentityId,
  name,
  bearerToken,
  onDeleted,
}: {
  organizationId: string;
  environmentId: string;
  capabilityIdentityId: string;
  name: string;
  bearerToken: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  async function remove() {
    setDeleting(true);
    setError(undefined);
    try {
      await deleteCapability(organizationId, environmentId, capabilityIdentityId, bearerToken);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this capability.');
    } finally {
      setDeleting(false);
    }
  }
  return (
    <section className="cat-delete-capability" aria-label="Delete capability">
      {confirming ? (
        <>
          <p>
            Delete {name} from {environmentId}? It will be hidden from the catalog and unavailable
            for new drafts. Rediscovery will not restore it. Saved workflow dependencies prevent
            deletion.
          </p>
          <button
            className="wf-action"
            type="button"
            disabled={deleting}
            onClick={() => void remove()}
          >
            {deleting ? 'Deleting...' : 'Delete capability'}
          </button>
          <button
            className="wf-action"
            type="button"
            disabled={deleting}
            onClick={() => {
              setConfirming(false);
              setError(undefined);
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button className="wf-action" type="button" onClick={() => setConfirming(true)}>
          Delete capability
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
