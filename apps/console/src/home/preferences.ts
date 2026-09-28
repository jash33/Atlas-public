export const homeWidgetIds = [
  'environment',
  'reviews',
  'runs',
  'drift',
  'capabilities',
  'activity',
  'configuration',
] as const;

export type HomeWidgetId = (typeof homeWidgetIds)[number];

export const homeWidgetsStorageKey = 'atlas.console.home-widgets';

export function parseHomeWidgetIds(value: string | null): HomeWidgetId[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return homeWidgetIds.filter((widgetId) => parsed.includes(widgetId));
  } catch {
    return [];
  }
}

export function readHomeWidgetIds(storage: Pick<Storage, 'getItem'>): HomeWidgetId[] {
  try {
    return parseHomeWidgetIds(storage.getItem(homeWidgetsStorageKey));
  } catch {
    return [];
  }
}

export function writeHomeWidgetIds(
  storage: Pick<Storage, 'setItem'>,
  widgetIds: HomeWidgetId[],
): void {
  try {
    storage.setItem(homeWidgetsStorageKey, JSON.stringify(widgetIds));
  } catch {
    // The selection remains usable for this session when persistence is unavailable.
  }
}

export function toggleHomeWidget(
  selectedWidgetIds: HomeWidgetId[],
  widgetId: HomeWidgetId,
): HomeWidgetId[] {
  const selected = new Set(selectedWidgetIds);
  if (selected.has(widgetId)) selected.delete(widgetId);
  else selected.add(widgetId);
  return homeWidgetIds.filter((candidate) => selected.has(candidate));
}
