import { expect, it } from 'vite-plus/test';
import { continueDraftProgress, type DraftRequestProgress } from './draft-request-progress.js';

it('keeps repair history and elapsed time without duplicating events on each poll', () => {
  const original: DraftRequestProgress = {
    requestId: 'original',
    startedAt: '2026-09-13T00:00:00Z',
    status: 'completed',
    liveText: true,
    events: [
      { sequence: 0, timestamp: 'now', kind: 'planning.stage', data: { stage: 'building' } },
    ],
  };
  const repair: DraftRequestProgress = {
    requestId: 'repair',
    startedAt: '2026-09-13T00:01:00Z',
    status: 'running',
    stage: 'understanding',
    liveText: true,
    events: [
      { sequence: 0, timestamp: 'later', kind: 'planning.stage', data: { stage: 'understanding' } },
    ],
  };
  const first = continueDraftProgress(original, repair);
  const second = continueDraftProgress(first, repair);
  expect(second.startedAt).toBe(original.startedAt);
  expect(second.stage).toBe('repairing');
  expect(second.events).toHaveLength(2);
  expect(continueDraftProgress(second, { ...repair, stage: 'validating' }).stage).toBe(
    'validating',
  );
});
