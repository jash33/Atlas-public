import { useCallback, useState } from 'react';

import { OperationEvidenceDrawer } from '../capabilities/OperationEvidenceDrawer.js';
import { useConsoleSession } from '../shell/session.js';
import {
  closeCapabilityDrawer,
  openCapabilityDrawer,
  type CapabilityDrawerState,
} from '../workflows/diagram-drawer.js';
import { diagramFromReviewGraph } from '../workflows/diagram-model.js';
import { WorkflowDiagram } from '../workflows/WorkflowDiagram.js';
import type { WorkflowReview } from '../workflows/workflow.js';
import { loadCatalogWorkflowReview, useScopedRemote } from './catalog.js';

export function CatalogWorkflowDiagram({
  workflowId,
  workflowVersionId,
  active,
}: {
  workflowId: string;
  workflowVersionId: string;
  active: boolean;
}) {
  const { organizationId, environmentId, role } = useConsoleSession();
  const [drawer, setDrawer] = useState<CapabilityDrawerState>({
    capabilityVersionId: null,
    restoreFocusStepId: null,
  });
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { review } = await loadCatalogWorkflowReview<WorkflowReview>(
        organizationId,
        environmentId,
        workflowId,
        workflowVersionId,
        signal,
      );
      return diagramFromReviewGraph(
        review.graph,
        review.steps,
        [],
        review.artifact?.mappingOrigins ?? [],
      );
    },
    [organizationId, environmentId, workflowId, workflowVersionId],
  );
  const { remote, reload } = useScopedRemote(
    `${organizationId}:${environmentId}:${workflowId}:${workflowVersionId}`,
    load,
    'Workflow diagram could not load',
  );
  if (remote.status === 'loading')
    return (
      <section className="wfd-panel" aria-busy="true">
        Loading workflow diagram…
      </section>
    );
  if (remote.status === 'error')
    return (
      <section className="wfd-panel" role="alert">
        <h2>Workflow diagram could not load</h2>
        <p>{remote.message}</p>
        <button type="button" onClick={reload}>
          Try again
        </button>
      </section>
    );
  const close = () => setDrawer(closeCapabilityDrawer(drawer));
  return (
    <>
      <WorkflowDiagram
        title="Workflow diagram"
        versionLabel={`${active ? 'Active version' : 'Approved version'} · ${workflowVersionId}`}
        validatedLabel="Saved version"
        preview={{ status: 'server', graph: remote.data }}
        targets={{ nodeMarkers: {}, edgeMarkers: {}, diagramMarkers: [] }}
        drawer={drawer}
        onCloseDrawer={close}
        onOpenNode={(node) => setDrawer(openCapabilityDrawer(node))}
      />
      {drawer.capabilityVersionId && (
        <OperationEvidenceDrawer
          capabilityVersionId={drawer.capabilityVersionId}
          organizationId={organizationId}
          environmentId={environmentId}
          role={role}
          onClose={close}
          onSelectVersion={(capabilityVersionId) =>
            setDrawer((current) => ({ ...current, capabilityVersionId }))
          }
        />
      )}
    </>
  );
}
