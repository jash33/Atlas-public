import { describe, expect, it, vi } from 'vite-plus/test';
import type { Pool } from 'pg';

import { createApp } from './app.js';
import {
  createBurgerTownMonitor,
  type BurgerTownMonitoringStore,
  type PollingClock,
  type PollingHttp,
  type PollingTarget,
  type RuntimeMismatchNotifier,
} from './burger-town-monitor.js';

const scope = { organizationId: 'org_burger_town', environmentId: 'development' };

function targets(): PollingTarget[] {
  return Array.from({ length: 15 }, (_, index) => ({
    definitionKey: `burger-town:operation-${index + 1}`,
    revision: 1,
    capabilityVersionId: `capability-${index + 1}`,
    url: `http://burger-town.test/__atlas/demo/operation-${index + 1}`,
    method: 'POST',
    requestBody: { fixture: 'burger-town-demo' },
    expectedStatus: 200,
    recognizedError: {
      status: 400,
      code: 'required_field_missing',
      codePath: ['code'],
      fieldPathPath: ['fieldPath'],
      ...(index === 8 ? { fieldPath: 'extraLettuce' } : {}),
    },
  }));
}

function fakeStore(configuredTargets = targets()): BurgerTownMonitoringStore & {
  states: string[];
  baselines: string[];
  recoveries: string[];
  mismatches: Array<{
    definitionKey: string;
    status: number;
    reason: string;
    fieldPath: string;
  }>;
  failures: Array<{ definitionKey: string; reason: string; status: number | null }>;
} {
  let status: Awaited<ReturnType<BurgerTownMonitoringStore['readStatus']>> = {
    state: 'stopped' as const,
    lastCompletedSweepAt: null,
    readinessMessage: null,
  };
  return {
    states: [],
    baselines: [],
    recoveries: [],
    mismatches: [],
    failures: [],
    async readStatus() {
      return status;
    },
    async loadReadyTargets() {
      return configuredTargets;
    },
    async hasSuccessfulBaseline(_scope, target) {
      return this.baselines.includes(target.definitionKey);
    },
    async saveStatus(_scope, next) {
      status = next;
      this.states.push(next.state);
    },
    async saveSuccessfulResponse(_scope, target) {
      this.baselines.push(target.definitionKey);
      const hadActiveMismatch = this.mismatches.some(
        (mismatch) => mismatch.definitionKey === target.definitionKey,
      );
      if (!hadActiveMismatch || this.recoveries.includes(target.definitionKey)) return [];
      this.recoveries.push(target.definitionKey);
      return [
        {
          id: 'runtime-mismatch-1',
          conditionKey: 'runtime-mismatch-condition-1',
        },
      ];
    },
    async saveRuntimeMismatch(_scope, target, mismatch) {
      this.mismatches.push({ definitionKey: target.definitionKey, ...mismatch });
      return 'runtime-mismatch-1';
    },
    async savePollingFailure(_scope, target, failure) {
      this.failures.push({ definitionKey: target.definitionKey, ...failure });
    },
  };
}

function fakeClock(): PollingClock & {
  runIntervals: () => Promise<void>;
  runTimeouts: () => void;
  advance: (milliseconds: number) => void;
} {
  let current = new Date('2026-09-04T15:00:00.000Z');
  const intervals = new Set<() => void | Promise<void>>();
  const timeouts = new Set<() => void>();
  return {
    now: () => current,
    repeat(callback) {
      intervals.add(callback);
      return () => intervals.delete(callback);
    },
    after(callback) {
      timeouts.add(callback);
      return () => timeouts.delete(callback);
    },
    async runIntervals() {
      await Promise.all(
        [...intervals].map(async (callback) => {
          await callback();
        }),
      );
    },
    runTimeouts() {
      for (const callback of [...timeouts]) callback();
    },
    advance(milliseconds) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function successfulHttp(): PollingHttp & { calls: string[] } {
  return {
    calls: [],
    async send(target) {
      this.calls.push(target.definitionKey);
      return { status: target.expectedStatus, body: null };
    },
  };
}

describe('Burger Town monitoring', () => {
  it('allows cancellation and a new start while old startup work is still pending', async () => {
    const store = fakeStore();
    const save = store.saveSuccessfulResponse.bind(store);
    let release!: () => void;
    const pending = new Promise<[]>((resolve) => {
      release = () => resolve([]);
    });
    store.saveSuccessfulResponse = vi
      .fn<BurgerTownMonitoringStore['saveSuccessfulResponse']>()
      .mockReturnValueOnce(pending)
      .mockImplementation(save);
    const monitor = createBurgerTownMonitor(store, successfulHttp(), fakeClock());
    const first = monitor.start(scope);
    await vi.waitFor(() => expect(store.saveSuccessfulResponse).toHaveBeenCalled());
    expect((await monitor.stop(scope)).state).toBe('stopped');
    expect((await monitor.start(scope)).state).toBe('active');
    release();
    await first;
    expect((await monitor.read(scope)).state).toBe('active');
  });
  it('cleans up a failed startup so the user can start again', async () => {
    const store = fakeStore();
    const save = store.saveSuccessfulResponse.bind(store);
    store.saveSuccessfulResponse = vi
      .fn<BurgerTownMonitoringStore['saveSuccessfulResponse']>()
      .mockRejectedValueOnce(new Error('internal failure'))
      .mockImplementation(save);
    const monitor = createBurgerTownMonitor(store, successfulHttp(), fakeClock());
    expect(await monitor.start(scope)).toMatchObject({
      state: 'stopped',
      readinessMessage: expect.stringContaining('Start monitoring'),
    });
    expect((await monitor.read(scope)).state).toBe('stopped');
    expect((await monitor.start(scope)).state).toBe('active');
  });

  it('stops with a recovery message when a recurring check cannot be recorded', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const monitor = createBurgerTownMonitor(store, successfulHttp(), clock);
    await monitor.start(scope);
    store.saveSuccessfulResponse = vi
      .fn<BurgerTownMonitoringStore['saveSuccessfulResponse']>()
      .mockRejectedValue(new Error('internal failure'));
    await clock.runIntervals();
    expect(await monitor.read(scope)).toMatchObject({
      state: 'stopped',
      lastCompletedSweepAt: '2026-09-04T15:00:00.000Z',
      readinessMessage: expect.stringContaining('Start monitoring'),
    });
  });
  it('detects a newly required field on a discovered target without a configured field name', async () => {
    const target = targets()[0]!;
    target.acceptAnyStatus = true;
    const store = fakeStore([target]);
    const clock = fakeClock();
    let broken = false;
    const monitor = createBurgerTownMonitor(
      store,
      {
        async send() {
          return broken
            ? { status: 400, body: { code: 'required_field_missing', fieldPath: 'kitchenNote' } }
            : { status: 200, body: {} };
        },
      },
      clock,
    );
    await monitor.start(scope);
    broken = true;
    await clock.runIntervals();
    expect(store.mismatches).toEqual([
      {
        definitionKey: target.definitionKey,
        status: 400,
        reason: 'required-field-missing',
        fieldPath: 'kitchenNote',
      },
    ]);
    expect(store.baselines).toHaveLength(1);
  });

  it('never treats an HTTP error as a successful baseline, even for a legacy permissive target', async () => {
    const target = targets()[0]!;
    target.acceptAnyStatus = true;
    const store = fakeStore([target]);
    const monitor = createBurgerTownMonitor(
      store,
      {
        async send() {
          return { status: 404, body: {} };
        },
      },
      fakeClock(),
    );
    await expect(monitor.start(scope)).resolves.toMatchObject({ state: 'stopped' });
    expect(store.baselines).toEqual([]);
  });

  it('uses every ready polling target without requiring a fixed inventory size', async () => {
    const monitor = createBurgerTownMonitor(
      fakeStore(targets().slice(0, 14)),
      successfulHttp(),
      fakeClock(),
    );

    await expect(monitor.read(scope)).resolves.toEqual({
      state: 'stopped',
      lastCompletedSweepAt: null,
      readinessMessage: null,
    });
  });

  it('keeps Start monitoring unavailable when no polling targets are ready', async () => {
    const monitor = createBurgerTownMonitor(fakeStore([]), successfulHttp(), fakeClock());

    await expect(monitor.read(scope)).resolves.toEqual({
      state: 'unavailable',
      lastCompletedSweepAt: null,
      readinessMessage: 'Burger Town has no ready polling targets',
    });
  });

  it('reports an interrupted active state after the Backend restarts', async () => {
    const store = fakeStore();
    await store.saveStatus(scope, {
      state: 'active',
      lastCompletedSweepAt: '2026-09-04T14:59:59.000Z',
      readinessMessage: null,
    });
    const monitor = createBurgerTownMonitor(store, successfulHttp(), fakeClock());

    await expect(monitor.read(scope)).resolves.toEqual({
      state: 'stopped',
      lastCompletedSweepAt: '2026-09-04T14:59:59.000Z',
      readinessMessage: 'Monitoring was interrupted. Select Start monitoring to resume.',
    });
  });

  it('uses one first sweep when Start monitoring is selected twice at the same time', async () => {
    const store = fakeStore();
    const http = successfulHttp();
    const monitor = createBurgerTownMonitor(store, http, fakeClock());

    const [first, second] = await Promise.all([monitor.start(scope), monitor.start(scope)]);

    expect(first.state).toBe('active');
    expect(second.state).toBe('active');
    expect(http.calls).toHaveLength(15);
  });

  it('checks all 15 targets before beginning the one-second loop', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const http = successfulHttp();
    const monitor = createBurgerTownMonitor(store, http, clock);

    const started = await monitor.start(scope);

    expect(started).toEqual({
      state: 'active',
      lastCompletedSweepAt: '2026-09-04T15:00:00.000Z',
      readinessMessage: null,
    });
    expect(store.states).toEqual(['starting', 'active']);
    expect(http.calls).toHaveLength(15);
    expect(store.baselines).toHaveLength(15);

    clock.advance(1_000);
    await clock.runIntervals();
    expect(http.calls).toHaveLength(30);
    await expect(monitor.read(scope)).resolves.toMatchObject({
      state: 'active',
      lastCompletedSweepAt: '2026-09-04T15:00:01.000Z',
    });
  });

  it('reports a failed first sweep as a readiness problem and does not begin the loop', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const http: PollingHttp = {
      async send(target) {
        return { status: target.definitionKey.endsWith('-8') ? 503 : 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock);

    await expect(monitor.start(scope)).resolves.toEqual({
      state: 'stopped',
      lastCompletedSweepAt: null,
      readinessMessage: 'operation-8 did not return its expected success response',
    });

    await clock.runIntervals();
    expect(store.states).toEqual(['starting', 'stopped']);
    expect(store.baselines).toHaveLength(14);
  });

  it('times out a slow target without delaying the other first-sweep results', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    let completed = 0;
    const http: PollingHttp = {
      async send(target) {
        if (target.definitionKey.endsWith('-1')) return new Promise(() => undefined);
        completed += 1;
        return { status: 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock);

    const starting = monitor.start(scope);
    await vi.waitFor(() => expect(completed).toBe(14));
    clock.runTimeouts();

    await expect(starting).resolves.toMatchObject({
      state: 'stopped',
      readinessMessage: 'operation-1 timed out',
    });
    expect(store.baselines).toHaveLength(14);
  });

  it('does not overlap one target and ignores its unfinished result after Stop monitoring', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const firstCalls = new Map<string, number>();
    let finishSlowRequest: ((value: { status: number; body: null }) => void) | undefined;
    const http: PollingHttp = {
      async send(target) {
        const callCount = (firstCalls.get(target.definitionKey) ?? 0) + 1;
        firstCalls.set(target.definitionKey, callCount);
        if (target.definitionKey.endsWith('-1') && callCount === 2) {
          return new Promise((resolve) => {
            finishSlowRequest = resolve;
          });
        }
        return { status: 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock);
    await monitor.start(scope);

    const firstInterval = clock.runIntervals();
    await vi.waitFor(() => expect(firstCalls.get('burger-town:operation-2')).toBe(2));
    await Promise.resolve();
    await clock.runIntervals();
    expect(firstCalls.get('burger-town:operation-1')).toBe(2);
    expect(firstCalls.get('burger-town:operation-2')).toBe(3);

    await expect(monitor.stop(scope)).resolves.toMatchObject({ state: 'stopped' });
    finishSlowRequest?.({ status: 200, body: null });
    await firstInterval;
    expect(store.states.slice(-2)).toEqual(['stopping', 'stopped']);
  });

  it('records the configured Payments field failure after a successful first sweep', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const runtimeMismatchNotifier = {
      notify: vi.fn<RuntimeMismatchNotifier['notify']>(async () => undefined),
      recover: vi.fn<RuntimeMismatchNotifier['recover']>(async () => undefined),
    };
    const calls = new Map<string, number>();
    const http: PollingHttp = {
      async send(target) {
        const count = (calls.get(target.definitionKey) ?? 0) + 1;
        calls.set(target.definitionKey, count);
        if (target.definitionKey.endsWith('operation-9') && count > 1) {
          return {
            status: 400,
            body: {
              code: 'required_field_missing',
              fieldPath: 'extraLettuce',
              message: 'extraLettuce is required',
            },
          };
        }
        return { status: 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock, { runtimeMismatchNotifier });

    await monitor.start(scope);
    clock.advance(1_000);
    await clock.runIntervals();

    expect(store.mismatches).toEqual([
      {
        definitionKey: 'burger-town:operation-9',
        status: 400,
        reason: 'required-field-missing',
        fieldPath: 'extraLettuce',
      },
    ]);
    expect(runtimeMismatchNotifier.notify).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ definitionKey: 'burger-town:operation-9' }),
      {
        status: 400,
        reason: 'required-field-missing',
        fieldPath: 'extraLettuce',
      },
      'runtime-mismatch-1',
    );
  });

  it('keeps a known failure active through Stop and Start, then recovers after success', async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const runtimeMismatchNotifier = {
      notify: vi.fn<RuntimeMismatchNotifier['notify']>(async () => undefined),
      recover: vi.fn<RuntimeMismatchNotifier['recover']>(async () => undefined),
    };
    let paymentIsBroken = false;
    const http: PollingHttp = {
      async send(target) {
        if (paymentIsBroken && target.definitionKey.endsWith('operation-9')) {
          return {
            status: 400,
            body: {
              code: 'required_field_missing',
              fieldPath: 'extraLettuce',
              message: 'extraLettuce is required',
            },
          };
        }
        return { status: 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock, { runtimeMismatchNotifier });

    await monitor.start(scope);
    paymentIsBroken = true;
    clock.advance(1_000);
    await clock.runIntervals();
    expect(store.mismatches).toHaveLength(1);

    await monitor.stop(scope);
    expect(store.recoveries).toEqual([]);
    await expect(monitor.start(scope)).resolves.toMatchObject({ state: 'active' });
    expect(store.mismatches).toHaveLength(2);
    expect(store.recoveries).toEqual([]);

    paymentIsBroken = false;
    clock.advance(1_000);
    await clock.runIntervals();
    expect(store.recoveries).toEqual(['burger-town:operation-9']);
    expect(runtimeMismatchNotifier.recover).toHaveBeenCalledWith(
      scope,
      [
        {
          id: 'runtime-mismatch-1',
          conditionKey: 'runtime-mismatch-condition-1',
        },
      ],
      new Date('2026-09-04T15:00:02.000Z'),
    );
  });

  it.each([
    ['different field', 400, { code: 'required_field_missing', fieldPath: 'cheese' }],
    ['different code', 400, { code: 'invalid_order', fieldPath: 'extraLettuce' }],
    ['unreadable body', 400, 'not-json'],
    ['login failure', 401, { code: 'required_field_missing', fieldPath: 'extraLettuce' }],
    ['server error', 503, { code: 'required_field_missing', fieldPath: 'extraLettuce' }],
  ])('does not call %s a contract mismatch', async (_label, status, body) => {
    const store = fakeStore();
    const clock = fakeClock();
    const calls = new Map<string, number>();
    const http: PollingHttp = {
      async send(target) {
        const count = (calls.get(target.definitionKey) ?? 0) + 1;
        calls.set(target.definitionKey, count);
        return target.definitionKey.endsWith('operation-9') && count > 1
          ? { status, body }
          : { status: 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock);

    await monitor.start(scope);
    await clock.runIntervals();

    expect(store.mismatches).toEqual([]);
    expect(store.failures).toEqual([
      {
        definitionKey: 'burger-town:operation-9',
        reason: 'unrecognized-response',
        status,
      },
    ]);
  });

  it.each([
    ['timeout', 'timeout'],
    ['network failure', 'unreachable'],
  ] as const)('keeps a %s as ordinary polling evidence', async (failureKind, reason) => {
    const store = fakeStore();
    const clock = fakeClock();
    const calls = new Map<string, number>();
    const http: PollingHttp = {
      async send(target) {
        const count = (calls.get(target.definitionKey) ?? 0) + 1;
        calls.set(target.definitionKey, count);
        if (target.definitionKey.endsWith('operation-9') && count > 1) {
          if (failureKind === 'timeout') return new Promise(() => undefined);
          throw new Error('unreachable');
        }
        return { status: 200, body: null };
      },
    };
    const monitor = createBurgerTownMonitor(store, http, clock);
    await monitor.start(scope);

    const sweep = clock.runIntervals();
    await vi.waitFor(() => expect(calls.get('burger-town:operation-9')).toBe(2));
    if (failureKind === 'timeout') clock.runTimeouts();
    await sweep;

    expect(store.mismatches).toEqual([]);
    expect(store.failures).toContainEqual({
      definitionKey: 'burger-town:operation-9',
      reason,
      status: null,
    });
  });

  it.each(['author', 'operator', 'admin'] as const)(
    'lets a signed-in %s read, start, and stop monitoring',
    async (role) => {
      const store = fakeStore();
      const monitor = createBurgerTownMonitor(store, successfulHttp(), fakeClock());
      const pool = {
        async query() {
          return { rows: [{}] };
        },
      } as unknown as Pool;
      const app = createApp(
        pool,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          async authorize(request) {
            return request.authorizationHeader === `Bearer ${role}` &&
              request.organizationId === scope.organizationId &&
              request.action === 'view-organization'
              ? { actorId: `${role}-user`, role }
              : null;
          },
        },
        { burgerTownMonitor: monitor },
      );

      const read = await app.request(
        `/v1/burger-town-monitoring?organizationId=${scope.organizationId}&environmentId=${scope.environmentId}`,
        { headers: { authorization: `Bearer ${role}` } },
      );
      expect(read.status).toBe(200);
      await expect(read.json()).resolves.toMatchObject({ state: 'stopped' });

      for (const action of ['start', 'stop'] as const) {
        const response = await app.request(`/v1/burger-town-monitoring/${action}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${role}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(scope),
        });
        expect(response.status).toBe(200);
      }
    },
  );

  it('does not start polling when the Backend app is created or monitoring status is read', async () => {
    const store = fakeStore();
    const http = successfulHttp();
    const monitor = createBurgerTownMonitor(store, http, fakeClock());
    const pool = { query: async () => ({ rows: [{}] }) } as unknown as Pool;
    const app = createApp(
      pool,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        async authorize() {
          return { actorId: 'author-user', role: 'author' };
        },
      },
      { burgerTownMonitor: monitor },
    );

    await app.request(
      `/v1/burger-town-monitoring?organizationId=${scope.organizationId}&environmentId=${scope.environmentId}`,
      { headers: { authorization: 'Bearer author' } },
    );

    expect(http.calls).toEqual([]);
    expect(store.states).toEqual([]);
  });
});
