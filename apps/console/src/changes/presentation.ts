import { buildSourceUpdateTree, type SourceUpdateTree } from '../source-update-tree/tree.js';
import {
  buildChangeItems,
  type ChangeClassification,
  type ChangeDiscoveryDetail,
  type ChangeItem,
} from './changes.js';

export interface ChangeTreeEntry {
  discoveryId: string;
  trigger: ChangeDiscoveryDetail['trigger'];
  discoveredAt: string;
  classifications: ChangeClassification[];
  tree: SourceUpdateTree;
}

export interface ChangeSurfacePresentation {
  trees: ChangeTreeEntry[];
  listItems: ChangeItem[];
}

export function presentChangeDiscoveries(
  details: readonly ChangeDiscoveryDetail[],
): ChangeSurfacePresentation {
  const trees: ChangeTreeEntry[] = [];
  const listItems: ChangeItem[] = [];

  for (const detail of details) {
    const items = buildChangeItems([detail]);
    const tree = buildSourceUpdateTree({
      serviceId: detail.serviceId,
      changes: detail.changes,
    });
    if (tree) {
      trees.push({
        discoveryId: detail.discoveryId,
        trigger: detail.trigger,
        discoveredAt: detail.discoveredAt,
        classifications: detail.changes.map((change) => change.classification),
        tree,
      });
      listItems.push(...items.filter((item) => item.evidenceKind === 'runtime-rejection'));
      continue;
    }
    listItems.push(...items);
  }

  trees.sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt));
  listItems.sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt));
  return { trees, listItems };
}

export function treeMatchesFilter(
  entry: ChangeTreeEntry,
  filter: ChangeClassification | 'all',
): boolean {
  if (filter === 'all') return true;
  return entry.classifications.includes(filter);
}
