import { SourceUpdateTreeView } from '../source-update-tree/SourceUpdateTreeView.js';
import { buildSourceUpdateTree, type SourceUpdateTree } from '../source-update-tree/tree.js';
import { summarizeDiscoveryOutcome } from './catalog.js';
import { capabilityBlastRadiusHash } from './capability-map-route.js';
import type { DiscoveryResult } from './data.js';

export function presentFailedReingest(
  serviceId: string,
  result: DiscoveryResult,
): { tree: SourceUpdateTree | null; summary: string } {
  return {
    tree: buildSourceUpdateTree({ serviceId, changes: result.changes }),
    summary: summarizeDiscoveryOutcome(result),
  };
}

export function FailedReingestOutcome({
  serviceId,
  environmentId,
  result,
  compatibleSummary,
}: {
  serviceId: string;
  environmentId: 'development' | 'production';
  result: DiscoveryResult;
  compatibleSummary?: string;
}) {
  const presented = presentFailedReingest(serviceId, result);
  if (presented.tree) {
    return (
      <div className="sut-reingest" role="status">
        <p>Source update is not fully compatible</p>
        <a href={capabilityBlastRadiusHash(environmentId, result.discoveryId)}>View blast radius</a>
        <SourceUpdateTreeView tree={presented.tree} />
      </div>
    );
  }
  return (
    <p className="cat-submit-result cat-submit-good" role="status">
      {compatibleSummary ?? presented.summary}
    </p>
  );
}
