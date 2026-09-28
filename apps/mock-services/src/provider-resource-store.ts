import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';

/**
 * Workflow-agnostic state for the mock provider estate.
 *
 * The store knows nothing about payments or invoices. Every resource is an opaque JSON document
 * addressed by `(serviceId, collection, resourceId)` and guarded by a version. One idempotency
 * ledger spans every service, and operation history is tagged by service so a route module can
 * read back its own observations. The provider ID is the isolation boundary: `reset` only touches
 * rows that belong to the configured provider.
 */
export interface ResourceKey {
  serviceId: string;
  collection: string;
  resourceId: string;
}

export interface StoredResource<TDocument = unknown> {
  document: TDocument;
  version: number;
}

export interface SeedResource extends ResourceKey {
  document: unknown;
  version: number;
}

export type TransitionDecision<TDocument> =
  | { kind: 'apply'; document: TDocument }
  | { kind: 'reject'; errorType: string };

export type MutationOutcome<TDocument> =
  | { kind: 'applied'; before: StoredResource<TDocument>; after: StoredResource<TDocument> }
  | { kind: 'replayed'; result: unknown; current: StoredResource<TDocument> | undefined }
  | { kind: 'not-found' }
  | { kind: 'version-conflict'; current: StoredResource<TDocument> }
  | { kind: 'rejected'; errorType: string; current: StoredResource<TDocument> };

export interface MutationRequest<TDocument> extends ResourceKey {
  operationId: string;
  /** Optimistic-concurrency guard; `null` skips the version check. */
  expectedVersion: number | null;
  /** Participates in the provider-wide idempotency ledger; `null` opts out. */
  idempotencyKey: string | null;
  transition: (current: StoredResource<TDocument>) => TransitionDecision<TDocument>;
  /** Builds an operation-history observation that is recorded atomically with the mutation. */
  observe?: (outcome: MutationOutcome<TDocument>) => unknown;
}

export interface OperationRecord {
  serviceId: string;
  operationId: string;
  observation: unknown;
}

export interface IdempotentClaim {
  replayed: boolean;
  result: unknown;
}

export interface ProviderResourceStore {
  reset(resources: readonly SeedResource[]): Promise<void>;
  merge(resources: readonly SeedResource[]): Promise<void>;
  listResources(serviceId?: string, collection?: string): Promise<SeedResource[]>;
  read<TDocument = unknown>(key: ResourceKey): Promise<StoredResource<TDocument> | undefined>;
  list<TDocument = unknown>(
    serviceId: string,
    collection: string,
  ): Promise<StoredResource<TDocument>[]>;
  mutate<TDocument = unknown>(
    request: MutationRequest<TDocument>,
  ): Promise<MutationOutcome<TDocument>>;
  findIdempotent(idempotencyKey: string): Promise<{ result: unknown } | undefined>;
  claimIdempotent(idempotencyKey: string, result: unknown): Promise<IdempotentClaim>;
  recordOperation(record: OperationRecord): Promise<void>;
  idempotencyKeys(): Promise<string[]>;
  operationHistory(serviceId?: string): Promise<OperationRecord[]>;
  close(): Promise<void>;
}

function decide<TDocument>(
  request: MutationRequest<TDocument>,
  current: StoredResource<TDocument> | undefined,
  prior: { result: unknown } | undefined,
): MutationOutcome<TDocument> {
  if (prior) return { kind: 'replayed', result: prior.result, current };
  if (!current) return { kind: 'not-found' };
  if (request.expectedVersion !== null && current.version !== request.expectedVersion) {
    return { kind: 'version-conflict', current };
  }
  const decision = request.transition(current);
  if (decision.kind === 'reject') {
    return { kind: 'rejected', errorType: decision.errorType, current };
  }
  return {
    kind: 'applied',
    before: current,
    after: { document: decision.document, version: current.version + 1 },
  };
}

const resourceKeyOf = ({ serviceId, collection, resourceId }: ResourceKey) =>
  JSON.stringify([serviceId, collection, resourceId]);

const parseResourceKey = (key: string): ResourceKey => {
  const [serviceId, collection, resourceId] = JSON.parse(key) as [string, string, string];
  return { serviceId, collection, resourceId };
};

const byCodePoint = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * In-memory implementation. Listing order matches the PostgreSQL implementation (sorted by
 * resource ID / idempotency key) so `/__control/observations` reads the same either way.
 */
export class MemoryProviderResourceStore implements ProviderResourceStore {
  readonly #resources = new Map<string, StoredResource>();
  readonly #idempotency = new Map<string, unknown>();
  readonly #history: OperationRecord[] = [];

  async reset(resources: readonly SeedResource[]) {
    this.#resources.clear();
    this.#idempotency.clear();
    this.#history.length = 0;
    await this.merge(resources);
  }

  async merge(resources: readonly SeedResource[]) {
    for (const resource of resources) {
      this.#resources.set(resourceKeyOf(resource), {
        document: resource.document,
        version: resource.version,
      });
    }
  }

  async listResources(serviceId?: string, collection?: string) {
    return [...this.#resources.entries()]
      .map(([key, resource]) => ({ ...parseResourceKey(key), ...resource }))
      .filter(
        (resource) =>
          (!serviceId || resource.serviceId === serviceId) &&
          (!collection || resource.collection === collection),
      )
      .sort((left, right) =>
        byCodePoint(
          `${left.serviceId}\0${left.collection}\0${left.resourceId}`,
          `${right.serviceId}\0${right.collection}\0${right.resourceId}`,
        ),
      );
  }

  async read<TDocument>(key: ResourceKey) {
    return this.#resources.get(resourceKeyOf(key)) as StoredResource<TDocument> | undefined;
  }

  async list<TDocument>(serviceId: string, collection: string) {
    return [...this.#resources.entries()]
      .map(([key, resource]) => ({ key: parseResourceKey(key), resource }))
      .filter(({ key }) => key.serviceId === serviceId && key.collection === collection)
      .sort((left, right) => byCodePoint(left.key.resourceId, right.key.resourceId))
      .map(({ resource }) => resource as StoredResource<TDocument>);
  }

  async mutate<TDocument>(request: MutationRequest<TDocument>) {
    const key = resourceKeyOf(request);
    const current = this.#resources.get(key) as StoredResource<TDocument> | undefined;
    const prior =
      request.idempotencyKey !== null && this.#idempotency.has(request.idempotencyKey)
        ? { result: this.#idempotency.get(request.idempotencyKey) }
        : undefined;
    const outcome = decide(request, current, prior);
    if (outcome.kind === 'applied') {
      this.#resources.set(key, outcome.after);
      if (request.idempotencyKey !== null) {
        this.#idempotency.set(request.idempotencyKey, outcome.after.document);
      }
    }
    if (request.observe) {
      this.#history.push({
        serviceId: request.serviceId,
        operationId: request.operationId,
        observation: request.observe(outcome),
      });
    }
    return outcome;
  }

  async findIdempotent(idempotencyKey: string) {
    return this.#idempotency.has(idempotencyKey)
      ? { result: this.#idempotency.get(idempotencyKey) }
      : undefined;
  }

  async claimIdempotent(idempotencyKey: string, result: unknown) {
    if (this.#idempotency.has(idempotencyKey)) {
      return { replayed: true, result: this.#idempotency.get(idempotencyKey) };
    }
    this.#idempotency.set(idempotencyKey, result);
    return { replayed: false, result };
  }

  async recordOperation(record: OperationRecord) {
    this.#history.push(record);
  }

  async idempotencyKeys() {
    return [...this.#idempotency.keys()].sort(byCodePoint);
  }

  async operationHistory(serviceId?: string) {
    return this.#history.filter((record) => !serviceId || record.serviceId === serviceId);
  }

  async close() {}
}

interface ResourceRow {
  document: unknown;
  version: string | number;
}

interface KeyedResourceRow extends ResourceRow {
  service_id: string;
  collection: string;
  resource_id: string;
}

const toStoredResource = <TDocument>(row: ResourceRow): StoredResource<TDocument> => ({
  document: row.document as TDocument,
  version: Number(row.version),
});

export class PostgresProviderResourceStore implements ProviderResourceStore {
  readonly #pool: Pool;
  readonly #providerId: string;
  readonly #ready: Promise<void>;

  constructor(connectionString: string, providerId: string) {
    if (!providerId.trim()) throw new Error('Mock provider ID must be explicit');
    this.#providerId = providerId;
    this.#pool = new Pool({ connectionString });
    this.#ready = this.#initialize();
  }

  async #initialize() {
    await this.#transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(175)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS mock_provider_resources (
          provider_id text NOT NULL,
          service_id text NOT NULL,
          collection text NOT NULL,
          resource_id text NOT NULL,
          document jsonb NOT NULL,
          version bigint NOT NULL,
          PRIMARY KEY (provider_id, service_id, collection, resource_id)
        );
        CREATE TABLE IF NOT EXISTS mock_provider_idempotency (
          provider_id text NOT NULL,
          idempotency_key text NOT NULL,
          result jsonb NOT NULL,
          PRIMARY KEY (provider_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS mock_provider_operation_history (
          sequence bigserial PRIMARY KEY,
          provider_id text NOT NULL,
          service_id text NOT NULL,
          operation_id text NOT NULL,
          observation jsonb NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mock_provider_operation_history_provider
          ON mock_provider_operation_history (provider_id, sequence);
        -- Billing-specific tables from before #175; their rows were demo fixtures reset on every
        -- Compose start, so nothing is migrated.
        DROP TABLE IF EXISTS mock_billing_operation_history;
        DROP TABLE IF EXISTS mock_billing_idempotency;
        DROP TABLE IF EXISTS mock_billing_invoices;
      `);
    });
  }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reset(resources: readonly SeedResource[]) {
    await this.#ready;
    await this.#transaction(async (client) => {
      for (const table of [
        'mock_provider_operation_history',
        'mock_provider_idempotency',
        'mock_provider_resources',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE provider_id = $1`, [this.#providerId]);
      }
      await this.#mergeWith(client, resources);
    });
  }

  async merge(resources: readonly SeedResource[]) {
    await this.#ready;
    await this.#transaction((client) => this.#mergeWith(client, resources));
  }

  async #mergeWith(client: PoolClient, resources: readonly SeedResource[]) {
    for (const resource of resources) {
      await client.query(
        `INSERT INTO mock_provider_resources
           (provider_id, service_id, collection, resource_id, document, version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider_id, service_id, collection, resource_id)
         DO UPDATE SET document = EXCLUDED.document, version = EXCLUDED.version`,
        [
          this.#providerId,
          resource.serviceId,
          resource.collection,
          resource.resourceId,
          JSON.stringify(resource.document),
          resource.version,
        ],
      );
    }
  }

  async listResources(serviceId?: string, collection?: string) {
    await this.#ready;
    const result = await this.#pool.query<KeyedResourceRow>(
      `SELECT service_id, collection, resource_id, document, version
       FROM mock_provider_resources
       WHERE provider_id = $1
         AND ($2::text IS NULL OR service_id = $2)
         AND ($3::text IS NULL OR collection = $3)
       ORDER BY service_id COLLATE "C", collection COLLATE "C", resource_id COLLATE "C"`,
      [this.#providerId, serviceId ?? null, collection ?? null],
    );
    return result.rows.map((row) => ({
      serviceId: row.service_id,
      collection: row.collection,
      resourceId: row.resource_id,
      document: row.document,
      version: Number(row.version),
    }));
  }

  async read<TDocument>(key: ResourceKey) {
    await this.#ready;
    return this.#readWith<TDocument>(this.#pool, key);
  }

  async #readWith<TDocument>(
    client: Pool | PoolClient,
    key: ResourceKey,
    lock = false,
  ): Promise<StoredResource<TDocument> | undefined> {
    const result = await client.query<ResourceRow>(
      `SELECT document, version FROM mock_provider_resources
       WHERE provider_id = $1 AND service_id = $2 AND collection = $3 AND resource_id = $4
       ${lock ? 'FOR UPDATE' : ''}`,
      [this.#providerId, key.serviceId, key.collection, key.resourceId],
    );
    return result.rows[0] ? toStoredResource<TDocument>(result.rows[0]) : undefined;
  }

  async list<TDocument>(serviceId: string, collection: string) {
    await this.#ready;
    const result = await this.#pool.query<ResourceRow>(
      `SELECT document, version FROM mock_provider_resources
       WHERE provider_id = $1 AND service_id = $2 AND collection = $3
       ORDER BY resource_id COLLATE "C"`,
      [this.#providerId, serviceId, collection],
    );
    return result.rows.map((row) => toStoredResource<TDocument>(row));
  }

  async mutate<TDocument>(request: MutationRequest<TDocument>) {
    await this.#ready;
    return this.#transaction(async (client) => {
      const current = await this.#readWith<TDocument>(client, request, true);
      const prior =
        request.idempotencyKey === null
          ? undefined
          : await this.#findIdempotentWith(client, request.idempotencyKey, true);
      const outcome = decide(request, current, prior);
      if (outcome.kind === 'applied') {
        await client.query(
          `UPDATE mock_provider_resources SET document = $5, version = $6
           WHERE provider_id = $1 AND service_id = $2 AND collection = $3 AND resource_id = $4`,
          [
            this.#providerId,
            request.serviceId,
            request.collection,
            request.resourceId,
            JSON.stringify(outcome.after.document),
            outcome.after.version,
          ],
        );
        if (request.idempotencyKey !== null) {
          await client.query(
            `INSERT INTO mock_provider_idempotency (provider_id, idempotency_key, result)
             VALUES ($1, $2, $3)`,
            [this.#providerId, request.idempotencyKey, JSON.stringify(outcome.after.document)],
          );
        }
      }
      if (request.observe) {
        await this.#recordWith(client, {
          serviceId: request.serviceId,
          operationId: request.operationId,
          observation: request.observe(outcome),
        });
      }
      return outcome;
    });
  }

  async #findIdempotentWith(client: Pool | PoolClient, idempotencyKey: string, lock = false) {
    const result = await client.query<{ result: unknown }>(
      `SELECT result FROM mock_provider_idempotency
       WHERE provider_id = $1 AND idempotency_key = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [this.#providerId, idempotencyKey],
    );
    return result.rows[0] ? { result: result.rows[0].result } : undefined;
  }

  async findIdempotent(idempotencyKey: string) {
    await this.#ready;
    return this.#findIdempotentWith(this.#pool, idempotencyKey);
  }

  async claimIdempotent(idempotencyKey: string, result: unknown): Promise<IdempotentClaim> {
    await this.#ready;
    return this.#transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO mock_provider_idempotency (provider_id, idempotency_key, result)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [this.#providerId, idempotencyKey, JSON.stringify(result)],
      );
      if (inserted.rowCount) return { replayed: false, result };
      const prior = await this.#findIdempotentWith(client, idempotencyKey);
      return { replayed: true, result: prior?.result };
    });
  }

  async #recordWith(client: Pool | PoolClient, record: OperationRecord) {
    await client.query(
      `INSERT INTO mock_provider_operation_history
         (provider_id, service_id, operation_id, observation)
       VALUES ($1, $2, $3, $4)`,
      [this.#providerId, record.serviceId, record.operationId, JSON.stringify(record.observation)],
    );
  }

  async recordOperation(record: OperationRecord) {
    await this.#ready;
    await this.#recordWith(this.#pool, record);
  }

  async idempotencyKeys() {
    await this.#ready;
    const result = await this.#pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM mock_provider_idempotency
       WHERE provider_id = $1 ORDER BY idempotency_key COLLATE "C"`,
      [this.#providerId],
    );
    return result.rows.map((row) => row.idempotency_key);
  }

  async operationHistory(serviceId?: string) {
    await this.#ready;
    const result = await this.#pool.query<{
      service_id: string;
      operation_id: string;
      observation: unknown;
    }>(
      `SELECT service_id, operation_id, observation FROM mock_provider_operation_history
       WHERE provider_id = $1 AND ($2::text IS NULL OR service_id = $2)
       ORDER BY sequence`,
      [this.#providerId, serviceId ?? null],
    );
    return result.rows.map((row) => ({
      serviceId: row.service_id,
      operationId: row.operation_id,
      observation: row.observation,
    }));
  }

  async close() {
    await this.#pool.end();
  }
}

export const uniqueProviderId = (prefix = 'test') => `${prefix}-${randomUUID()}`;
