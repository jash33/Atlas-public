import { z } from 'zod';

export type BurgerTownMonitoringState =
  | 'unavailable'
  | 'stopped'
  | 'starting'
  | 'active'
  | 'stopping';

export interface BurgerTownMonitoringScope {
  organizationId: string;
  environmentId: string;
}

export interface BurgerTownMonitoringStatus {
  state: BurgerTownMonitoringState;
  lastCompletedSweepAt: string | null;
  readinessMessage: string | null;
}

export interface PollingTarget {
  definitionKey: string;
  revision: number;
  capabilityVersionId: string;
  url: string;
  method: string;
  requestBody: Record<string, unknown>;
  expectedStatus: number;
  acceptAnyStatus?: boolean;
  recognizedError: {
    status: 400;
    code: string;
    codePath: readonly string[];
    fieldPathPath: readonly string[];
    fieldPath?: string;
  };
}

export interface PollingHttp {
  send(target: PollingTarget, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
}

export interface PollingClock {
  now(): Date;
  repeat(callback: () => void | Promise<void>, milliseconds: number): () => void;
  after(callback: () => void, milliseconds: number): () => void;
}

export interface BurgerTownMonitoringStore {
  readStatus(scope: BurgerTownMonitoringScope): Promise<BurgerTownMonitoringStatus>;
  loadReadyTargets(scope: BurgerTownMonitoringScope): Promise<readonly PollingTarget[]>;
  hasSuccessfulBaseline(scope: BurgerTownMonitoringScope, target: PollingTarget): Promise<boolean>;
  saveStatus(scope: BurgerTownMonitoringScope, status: BurgerTownMonitoringStatus): Promise<void>;
  saveSuccessfulResponse(
    scope: BurgerTownMonitoringScope,
    target: PollingTarget,
    succeededAt: Date,
  ): Promise<readonly RecoveredRuntimeMismatch[]>;
  saveRuntimeMismatch(
    scope: BurgerTownMonitoringScope,
    target: PollingTarget,
    mismatch: RuntimeContractMismatch,
    observedAt: Date,
  ): Promise<string | null>;
  savePollingFailure(
    scope: BurgerTownMonitoringScope,
    target: PollingTarget,
    failure: PollingFailure,
    observedAt: Date,
  ): Promise<void>;
}

export interface RuntimeMismatchNotifier {
  notify(
    scope: BurgerTownMonitoringScope,
    target: PollingTarget,
    mismatch: RuntimeContractMismatch,
    mismatchId: string,
  ): Promise<void>;
  recover(
    scope: BurgerTownMonitoringScope,
    mismatches: readonly RecoveredRuntimeMismatch[],
    recoveredAt: Date,
  ): Promise<void>;
}

export interface RecoveredRuntimeMismatch {
  id: string;
  conditionKey: string;
}

export interface RuntimeContractMismatch {
  status: number;
  reason: 'required-field-missing';
  fieldPath: string;
}

export interface PollingFailure {
  reason: 'unrecognized-response' | 'timeout' | 'unreachable';
  status: number | null;
}

export const burgerTownMonitoringScopeSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export class BurgerTownMonitoringUnavailable extends Error {}

interface RunningSession {
  cancelled: boolean;
  cancelInterval: (() => void) | null;
  requests: Map<string, AbortController>;
  targets: readonly PollingTarget[];
}

interface PollingResult {
  target: PollingTarget;
  outcome: 'success' | 'unexpected' | 'timeout' | 'failed' | 'skipped';
  response?: { status: number; body: unknown };
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function recognizeRuntimeContractMismatch(
  target: PollingTarget,
  response: { status: number; body: unknown },
): RuntimeContractMismatch | null {
  const expected = target.recognizedError;
  if (response.status !== expected.status) return null;
  if (valueAtPath(response.body, expected.codePath) !== expected.code) return null;
  const fieldPath = valueAtPath(response.body, expected.fieldPathPath);
  // Demo contract: HTTP 400 { code: 'required_field_missing', fieldPath: 'requestField' }.
  // A newly required field is learned from this evidence, after a successful baseline.
  if (typeof fieldPath !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.[\]-]{0,255}$/.test(fieldPath)) {
    return null;
  }
  if (expected.fieldPath && fieldPath !== expected.fieldPath) return null;
  return {
    status: response.status,
    reason: 'required-field-missing',
    fieldPath,
  };
}

function targetName(definitionKey: string) {
  return definitionKey.split(':').at(-1) ?? definitionKey;
}

function readinessMessage(result: PollingResult) {
  const name = targetName(result.target.definitionKey);
  if (result.outcome === 'timeout') return `${name} timed out`;
  if (result.outcome === 'unexpected') {
    return `${name} did not return its expected success response`;
  }
  return `${name} could not be reached`;
}

export function createBurgerTownMonitor(
  store: BurgerTownMonitoringStore,
  http: PollingHttp,
  clock: PollingClock,
  options: {
    intervalMilliseconds?: number;
    timeoutMilliseconds?: number;
    runtimeMismatchNotifier?: RuntimeMismatchNotifier;
  } = {},
) {
  const intervalMilliseconds = options.intervalMilliseconds ?? 1_000;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 800;
  const sessions = new Map<string, RunningSession>();
  const starts = new Map<string, Promise<BurgerTownMonitoringStatus>>();
  const sessionKey = (scope: BurgerTownMonitoringScope) =>
    `${scope.organizationId}\u0000${scope.environmentId}`;
  const unavailableForCount = (): BurgerTownMonitoringStatus => ({
    state: 'unavailable',
    lastCompletedSweepAt: null,
    readinessMessage: 'Burger Town has no ready polling targets',
  });

  async function failSession(scope: BurgerTownMonitoringScope, session: RunningSession) {
    const key = sessionKey(scope);
    if (sessions.get(key) !== session || session.cancelled) return store.readStatus(scope);
    session.cancelled = true;
    session.cancelInterval?.();
    for (const request of session.requests.values()) request.abort();
    sessions.delete(key);
    const previous = await store.readStatus(scope);
    const status: BurgerTownMonitoringStatus = {
      ...previous,
      state: 'stopped',
      readinessMessage:
        'Monitoring could not finish recording a check. Select Start monitoring to retry.',
    };
    await store.saveStatus(scope, status);
    return status;
  }

  async function pollTarget(
    session: RunningSession,
    target: PollingTarget,
  ): Promise<PollingResult> {
    if (session.cancelled || session.requests.has(target.definitionKey)) {
      return { target, outcome: 'skipped' };
    }
    const controller = new AbortController();
    session.requests.set(target.definitionKey, controller);
    let finishTimeout: ((result: PollingResult) => void) | undefined;
    const timeout = new Promise<PollingResult>((resolve) => {
      finishTimeout = resolve;
    });
    const cancelTimeout = clock.after(() => {
      controller.abort();
      finishTimeout?.({ target, outcome: 'timeout' });
    }, timeoutMilliseconds);
    try {
      const clearRequest = () => {
        if (session.requests.get(target.definitionKey) === controller) {
          session.requests.delete(target.definitionKey);
        }
      };
      const request = http.send(target, controller.signal).then(
        (response): PollingResult => {
          clearRequest();
          return {
            target,
            outcome:
              response.status >= 200 &&
              response.status <= 299 &&
              (target.acceptAnyStatus || response.status === target.expectedStatus)
                ? 'success'
                : 'unexpected',
            response,
          };
        },
        (): PollingResult => {
          clearRequest();
          return { target, outcome: 'failed' };
        },
      );
      return await Promise.race([request, timeout]);
    } finally {
      cancelTimeout();
    }
  }

  async function runSweep(scope: BurgerTownMonitoringScope, session: RunningSession) {
    const results = await Promise.all(session.targets.map((target) => pollTarget(session, target)));
    if (session.cancelled) return results;
    const observedAt = clock.now();
    await Promise.all(
      results.map(async (result) => {
        if (result.outcome === 'success') {
          const recovered = await store.saveSuccessfulResponse(scope, result.target, observedAt);
          if (recovered.length > 0) {
            await options.runtimeMismatchNotifier?.recover(scope, recovered, observedAt);
          }
          return;
        }
        if (result.outcome === 'unexpected' && result.response) {
          const mismatch = recognizeRuntimeContractMismatch(result.target, result.response);
          if (mismatch) {
            const mismatchId = await store.saveRuntimeMismatch(
              scope,
              result.target,
              mismatch,
              observedAt,
            );
            if (mismatchId) {
              await options.runtimeMismatchNotifier?.notify(
                scope,
                result.target,
                mismatch,
                mismatchId,
              );
            }
            return;
          }
          return store.savePollingFailure(
            scope,
            result.target,
            { reason: 'unrecognized-response', status: result.response.status },
            observedAt,
          );
        }
        if (result.outcome === 'timeout' || result.outcome === 'failed') {
          return store.savePollingFailure(
            scope,
            result.target,
            {
              reason: result.outcome === 'timeout' ? 'timeout' : 'unreachable',
              status: null,
            },
            observedAt,
          );
        }
      }),
    );
    const complete = results.every((result) => result.outcome !== 'skipped');
    if (complete && !session.cancelled) {
      await store.saveStatus(scope, {
        state: 'active',
        lastCompletedSweepAt: observedAt.toISOString(),
        readinessMessage: null,
      });
    }
    return results;
  }

  async function startMonitoring(
    scope: BurgerTownMonitoringScope,
    key: string,
  ): Promise<BurgerTownMonitoringStatus> {
    const existing = sessions.get(key);
    if (existing && !existing.cancelled) return store.readStatus(scope);

    const targets = await store.loadReadyTargets(scope);
    if (targets.length === 0) {
      throw new BurgerTownMonitoringUnavailable(unavailableForCount().readinessMessage!);
    }
    const session: RunningSession = {
      cancelled: false,
      cancelInterval: null,
      requests: new Map(),
      targets,
    };
    sessions.set(key, session);
    try {
      await store.saveStatus(scope, {
        state: 'starting',
        lastCompletedSweepAt: null,
        readinessMessage: null,
      });

      const results = await Promise.all(targets.map((target) => pollTarget(session, target)));
      if (session.cancelled) return store.readStatus(scope);
      const succeededAt = clock.now();
      await Promise.all(
        results
          .filter((result) => result.outcome === 'success')
          .map(async (result) => {
            const recovered = await store.saveSuccessfulResponse(scope, result.target, succeededAt);
            if (recovered.length > 0) {
              await options.runtimeMismatchNotifier?.recover(scope, recovered, succeededAt);
            }
          }),
      );
      const failedResults = results.filter((result) => result.outcome !== 'success');
      const failedBaselineChecks = await Promise.all(
        failedResults.map(async (result) => ({
          result,
          hasBaseline: await store.hasSuccessfulBaseline(scope, result.target),
        })),
      );
      const failedWithoutBaseline = failedBaselineChecks.find(
        (result) => !result.hasBaseline,
      )?.result;
      if (session.cancelled) return store.readStatus(scope);
      if (failedWithoutBaseline) {
        const status: BurgerTownMonitoringStatus = {
          state: 'stopped',
          lastCompletedSweepAt: null,
          readinessMessage: readinessMessage(failedWithoutBaseline),
        };
        sessions.delete(key);
        await store.saveStatus(scope, status);
        return status;
      }

      await Promise.all(
        failedResults.map(async (result) => {
          if (result.outcome === 'unexpected' && result.response) {
            const mismatch = recognizeRuntimeContractMismatch(result.target, result.response);
            if (mismatch) {
              const mismatchId = await store.saveRuntimeMismatch(
                scope,
                result.target,
                mismatch,
                succeededAt,
              );
              if (mismatchId) {
                await options.runtimeMismatchNotifier?.notify(
                  scope,
                  result.target,
                  mismatch,
                  mismatchId,
                );
              }
              return;
            }
            await store.savePollingFailure(
              scope,
              result.target,
              { reason: 'unrecognized-response', status: result.response.status },
              succeededAt,
            );
            return;
          }
          if (result.outcome === 'timeout' || result.outcome === 'failed') {
            await store.savePollingFailure(
              scope,
              result.target,
              {
                reason: result.outcome === 'timeout' ? 'timeout' : 'unreachable',
                status: null,
              },
              succeededAt,
            );
          }
        }),
      );

      if (session.cancelled) return store.readStatus(scope);
      const status: BurgerTownMonitoringStatus = {
        state: 'active',
        lastCompletedSweepAt: succeededAt.toISOString(),
        readinessMessage: null,
      };
      await store.saveStatus(scope, status);
      if (session.cancelled) return store.readStatus(scope);
      session.cancelInterval = clock.repeat(async () => {
        try {
          await runSweep(scope, session);
        } catch {
          await failSession(scope, session);
        }
      }, intervalMilliseconds);
      return status;
    } catch {
      return failSession(scope, session);
    }
  }

  return {
    async read(scope: BurgerTownMonitoringScope) {
      const status = await store.readStatus(scope);
      const key = sessionKey(scope);
      if (['starting', 'active', 'stopping'].includes(status.state) && !sessions.has(key)) {
        return {
          state: 'stopped' as const,
          lastCompletedSweepAt: status.lastCompletedSweepAt,
          readinessMessage: 'Monitoring was interrupted. Select Start monitoring to resume.',
        };
      }
      if (!['unavailable', 'stopped'].includes(status.state)) return status;
      try {
        const targets = await store.loadReadyTargets(scope);
        return targets.length > 0 ? status : unavailableForCount();
      } catch (error) {
        if (error instanceof BurgerTownMonitoringUnavailable) {
          return {
            state: 'unavailable',
            lastCompletedSweepAt: status.lastCompletedSweepAt,
            readinessMessage: error.message,
          };
        }
        throw error;
      }
    },

    async start(scope: BurgerTownMonitoringScope): Promise<BurgerTownMonitoringStatus> {
      const key = sessionKey(scope);
      const pending = starts.get(key);
      if (pending) return pending;
      const request = startMonitoring(scope, key);
      starts.set(key, request);
      try {
        return await request;
      } finally {
        if (starts.get(key) === request) starts.delete(key);
      }
    },

    async stop(scope: BurgerTownMonitoringScope): Promise<BurgerTownMonitoringStatus> {
      const key = sessionKey(scope);
      const previous = await store.readStatus(scope);
      if (previous.state === 'unavailable' || previous.state === 'stopped') return previous;
      await store.saveStatus(scope, { ...previous, state: 'stopping' });
      const session = sessions.get(key);
      starts.delete(key);
      if (session) {
        session.cancelled = true;
        session.cancelInterval?.();
        for (const request of session.requests.values()) request.abort();
        sessions.delete(key);
      }
      const stopped = { ...previous, state: 'stopped' as const };
      await store.saveStatus(scope, stopped);
      return stopped;
    },
  };
}

export type BurgerTownMonitor = ReturnType<typeof createBurgerTownMonitor>;
