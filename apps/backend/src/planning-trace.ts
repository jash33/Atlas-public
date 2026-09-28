import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const planningTraceSchemaVersion = 1;

export type PlanningTraceData = Record<string, unknown>;

export interface PlanningTraceRecord extends PlanningTraceData {
  version: typeof planningTraceSchemaVersion;
  timestamp: string;
  sequence: number;
  traceId: string;
  kind: string;
}

export interface PlanningTraceStart {
  request: unknown;
  actorId: string;
  authorizationFingerprint?: string;
}

function traceTimestampForFile(timestamp: string) {
  return timestamp.replaceAll(':', '-').replaceAll('.', '-');
}

export function traceFingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export const credentialFingerprint = traceFingerprint;

export function serializeTraceError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...('code' in error ? { code: error.code } : {}),
      ...('cause' in error ? { cause: String(error.cause) } : {}),
    };
  }
  return { value: error };
}

export class PlanningTrace {
  readonly traceId: string;
  readonly filePath: string;
  readonly #file: FileHandle;
  #sequence = 0;
  #writes: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(traceId: string, filePath: string, file: FileHandle) {
    this.traceId = traceId;
    this.filePath = filePath;
    this.#file = file;
  }

  record(kind: string, data: PlanningTraceData = {}) {
    if (this.#closed) {
      return Promise.reject(new Error(`Planning trace '${this.traceId}' is already closed`));
    }
    const record: PlanningTraceRecord = {
      ...data,
      version: planningTraceSchemaVersion,
      timestamp: new Date().toISOString(),
      sequence: this.#sequence,
      traceId: this.traceId,
      kind,
    };
    this.#sequence += 1;
    const line = `${JSON.stringify(record)}\n`;
    this.#writes = this.#writes.then(async () => {
      await this.#file.appendFile(line, 'utf8');
    });
    return this.#writes;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writes;
    await this.#file.close();
  }
}

export class PlanningTraceStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async start(input: PlanningTraceStart) {
    await mkdir(this.directory, { recursive: true });
    const traceId = randomUUID();
    const startedAt = new Date().toISOString();
    const filePath = join(this.directory, `${traceTimestampForFile(startedAt)}-${traceId}.jsonl`);
    const file = await open(filePath, 'wx', 0o600);
    const trace = new PlanningTrace(traceId, filePath, file);
    await trace.record('planning.started', {
      startedAt,
      request: input.request,
      requestFingerprint: traceFingerprint(JSON.stringify(input.request)),
      actorId: input.actorId,
      ...(input.authorizationFingerprint
        ? { authorizationFingerprint: input.authorizationFingerprint }
        : {}),
      runtime: {
        node: process.version,
        pid: process.pid,
        platform: process.platform,
        architecture: process.arch,
        hostname: hostname(),
        environment: process.env.NODE_ENV ?? null,
        sourceRevision:
          process.env.ATLAS_SOURCE_REVISION ??
          process.env.GITHUB_SHA ??
          process.env.SOURCE_VERSION ??
          null,
      },
    });
    return trace;
  }
}

const activePlanningTrace = new AsyncLocalStorage<PlanningTrace>();
const traceListener = new AsyncLocalStorage<
  (kind: string, data: PlanningTraceData) => Promise<void>
>();

export function runWithPlanningTraceListener<T>(
  listener: (kind: string, data: PlanningTraceData) => Promise<void>,
  callback: () => T,
) {
  return traceListener.run(listener, callback);
}

export function hasPlanningTraceListener() {
  return Boolean(traceListener.getStore());
}

export function runWithPlanningTrace<T>(trace: PlanningTrace, callback: () => T) {
  return activePlanningTrace.run(trace, callback);
}

export function currentPlanningTrace() {
  return activePlanningTrace.getStore();
}

export async function recordPlanningTrace(kind: string, data: PlanningTraceData = {}) {
  await traceListener.getStore()?.(kind, data);
  await activePlanningTrace.getStore()?.record(kind, data);
}
