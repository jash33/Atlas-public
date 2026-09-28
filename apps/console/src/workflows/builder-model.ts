import {
  objectSchemaSchema,
  type ObjectSchema,
  type ResponseValueSchema,
} from '@atlas/workflow-ir';
import {
  readCapabilityObservation,
  type CapabilityObservation,
} from './capability-definition-status.js';

export interface BuilderDocument {
  executable: unknown;
  layout: Record<string, { x: number; y: number }>;
  labels: Record<string, string>;
  notes: Array<{ id: string; text: string; x: number; y: number }>;
  trigger: { type: 'manual' | 'webhook' };
}

export interface BuilderCapability {
  capabilityVersionId: string;
  label: string;
  description: string;
  inputSchema: ObjectSchema;
  responseSchema: ObjectSchema;
  kind: 'capabilityCall' | 'publishEvent';
  observation?: CapabilityObservation;
}

export interface BuilderIssue {
  stepId?: string;
  message: string;
}

export type BuilderStep = Record<string, unknown> & { id: string; kind: string };
export function builderBlockWidth(step: { kind: string }): number {
  return ['capabilityCall', 'publishEvent', 'notify', 'compensation'].includes(step.kind)
    ? 840
    : 360;
}
export type BuilderBlockKind =
  | 'capabilityCall'
  | 'transform'
  | 'condition'
  | 'sleep'
  | 'terminal'
  | 'note';
export interface BuilderConnection {
  source: string;
  target: string;
  port: string;
}
export interface BuilderValueOption {
  label: string;
  type: string;
  value: unknown;
}
export const BUILDER_START_ID = '$start';

export function builderObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function builderText(value: unknown, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : fallback;
}

export function builderSteps(document: BuilderDocument): BuilderStep[] {
  const steps = builderObject(document.executable).steps;
  return Array.isArray(steps)
    ? steps.filter((value): value is BuilderStep => {
        const step = builderObject(value);
        return typeof step.id === 'string' && typeof step.kind === 'string';
      })
    : [];
}

export function builderSchema(value: unknown): ObjectSchema {
  const parsed = objectSchemaSchema.safeParse(value);
  return parsed.success ? parsed.data : { required: {} };
}

export function createBuilderDocument(
  executable?: unknown,
  capabilities: readonly BuilderCapability[] = [],
): BuilderDocument {
  let source = executable ?? {
    irVersion: 3,
    inputSchema: { required: {} },
    startStepId: 'finish',
    steps: [
      {
        id: 'finish',
        kind: 'terminal',
        state: 'completed',
        output: { source: 'literal', value: {} },
      },
    ],
  };
  const original = builderObject(source);
  if ((original.irVersion === 1 || original.irVersion === 2) && Array.isArray(original.steps)) {
    const known = original.steps.every((value) => {
      const step = builderObject(value);
      return (
        typeof step.id === 'string' &&
        ['capabilityCall', 'publishEvent', 'notify', 'compensation', 'terminal'].includes(
          builderText(step.kind),
        )
      );
    });
    if (known) {
      const steps = original.steps.map((value) => ({ ...builderObject(value) }) as BuilderStep);
      const ordinary = steps.filter((step) => step.kind !== 'compensation');
      // A terminal in the middle has unreachable legacy content. Keep it intact for source editing.
      const firstTerminal = ordinary.findIndex((step) => step.kind === 'terminal');
      if (firstTerminal === -1 || firstTerminal === ordinary.length - 1) {
        if (!ordinary.length || ordinary.at(-1)?.kind !== 'terminal') {
          const existing = new Set(steps.map(({ id }) => id));
          let id = 'finish';
          while (existing.has(id)) id += '_end';
          const terminal = { id, kind: 'terminal', state: 'completed' };
          steps.push(terminal);
          ordinary.push(terminal);
        }
        for (const step of steps) {
          if (step.kind !== 'terminal' && !step.inputSchema) {
            const capability = capabilities.find(
              (option) => option.capabilityVersionId === step.capabilityVersionId,
            );
            if (capability) step.inputSchema = capability.inputSchema;
            else
              step.inputSchema = {
                required: Object.fromEntries(
                  Object.entries(builderObject(step.arguments)).flatMap(([name, expression]) => {
                    const reference = builderObject(expression);
                    let field: ResponseValueSchema | undefined;
                    if (reference.source === 'literal') field = literalValueSchema(reference.value);
                    else if (reference.source === 'input')
                      field = referencedField(builderSchema(original.inputSchema), reference.path);
                    else if (reference.source === 'stepOutput')
                      field = referencedField(
                        builderSchema(
                          steps.find((sourceStep) => sourceStep.id === reference.stepId)
                            ?.responseSchema,
                        ),
                        reference.path,
                      );
                    return field ? [[name, field]] : [];
                  }),
                ),
              };
          }
          if (step.kind !== 'terminal' && step.kind !== 'compensation')
            step.next = ordinary[ordinary.indexOf(step) + 1]?.id ?? '';
          if (step.kind === 'terminal' && step.state === 'completed') {
            const previous = ordinary[ordinary.indexOf(step) - 1];
            if (previous) step.output = { source: 'stepOutput', stepId: previous.id, path: [] };
          }
        }
        source = { ...original, irVersion: 3, startStepId: ordinary[0]?.id ?? '', steps };
      }
    }
  }
  const document: BuilderDocument = {
    executable: source,
    layout: {},
    labels: {},
    notes: [],
    trigger: { type: 'manual' },
  };
  return arrangeBuilder(document);
}

function literalValueSchema(value: unknown): ResponseValueSchema | undefined {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return { type: typeof value } as ResponseValueSchema;
  if (Array.isArray(value))
    return { type: 'array', items: literalValueSchema(value[0]) ?? { type: 'string' } };
  if (value && typeof value === 'object')
    return {
      type: 'object',
      required: Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const child = literalValueSchema(item);
          return child ? [[key, child]] : [];
        }),
      ),
    };
  return undefined;
}

function referencedField(schema: ObjectSchema, path: unknown): ResponseValueSchema | undefined {
  if (!Array.isArray(path)) return undefined;
  let value: ResponseValueSchema = { type: 'object', required: schema.required };
  for (const part of path) {
    if (typeof part !== 'string' || value.type !== 'object' || !value.required[part])
      return undefined;
    value = value.required[part];
  }
  return value;
}

export function builderReadOnlyReason(document: BuilderDocument): string | undefined {
  const executable = builderObject(document.executable);
  if (executable.irVersion !== 3)
    return 'This workflow needs conversion before it can be edited in the builder. Its original definition is preserved.';
  if (!Array.isArray(executable.steps) || executable.steps.length !== builderSteps(document).length)
    return 'This draft contains steps the builder cannot read. Its original definition is preserved.';
  if (builderSteps(document).some((step) => !builderStepEditable(step)))
    return 'This draft contains a step type the builder cannot edit. Its original definition is preserved; use the source view to edit it.';
  const ids = builderSteps(document).map(({ id }) => id);
  if (new Set(ids).size !== ids.length || ids.includes(BUILDER_START_ID) || ids.some((id) => !id))
    return 'Step identifiers must be unique before the builder can edit this draft.';
  return undefined;
}

export function builderStepEditable(step: BuilderStep): boolean {
  return [
    'capabilityCall',
    'publishEvent',
    'notify',
    'transform',
    'condition',
    'sleep',
    'terminal',
    'compensation',
  ].includes(step.kind);
}

export function builderConnections(document: BuilderDocument): BuilderConnection[] {
  const executable = builderObject(document.executable);
  const connections: BuilderConnection[] = [];
  if (typeof executable.startStepId === 'string' && executable.startStepId) {
    connections.push({ source: BUILDER_START_ID, target: executable.startStepId, port: 'next' });
  }
  for (const step of builderSteps(document)) {
    if (step.kind === 'compensation') continue;
    for (const port of step.kind === 'condition' ? ['whenTrue', 'whenFalse'] : ['next']) {
      const target = step[port];
      if (typeof target === 'string' && target) connections.push({ source: step.id, target, port });
    }
  }
  return connections;
}

export function builderConnectionAllowed(
  document: BuilderDocument,
  connection: BuilderConnection,
): boolean {
  const steps = builderSteps(document);
  const source = steps.find(({ id }) => id === connection.source);
  const target = steps.find(({ id }) => id === connection.target);
  if (connection.source === connection.target || !target || target.kind === 'compensation')
    return false;
  if (connection.source === BUILDER_START_ID) return connection.port === 'next';
  if (!source || ['terminal', 'compensation'].includes(source.kind) || !builderStepEditable(source))
    return false;
  if (
    !(source.kind === 'condition' ? ['whenTrue', 'whenFalse'] : ['next']).includes(connection.port)
  )
    return false;
  const connections = builderConnections(document).filter(
    (edge) => edge.source !== connection.source || edge.port !== connection.port,
  );
  const pending = [connection.target];
  const visited = new Set<string>();
  while (pending.length) {
    const next = pending.pop();
    if (!next || visited.has(next)) continue;
    if (next === connection.source) return false;
    visited.add(next);
    pending.push(...connections.filter((edge) => edge.source === next).map((edge) => edge.target));
  }
  return true;
}

export function updateBuilderStep(
  document: BuilderDocument,
  stepId: string,
  update: Record<string, unknown>,
): BuilderDocument {
  const executable = builderObject(document.executable);
  return {
    ...document,
    executable: {
      ...executable,
      steps: builderSteps(document).map((step) =>
        step.id === stepId ? { ...step, ...update, id: step.id } : step,
      ),
    },
  };
}

export function connectBuilder(
  document: BuilderDocument,
  connection: BuilderConnection,
): BuilderDocument {
  if (!builderConnectionAllowed(document, connection)) return document;
  return connection.source === BUILDER_START_ID
    ? {
        ...document,
        executable: { ...builderObject(document.executable), startStepId: connection.target },
      }
    : updateBuilderStep(document, connection.source, { [connection.port]: connection.target });
}

export function disconnectBuilder(
  document: BuilderDocument,
  source: string,
  port: string,
): BuilderDocument {
  return source === BUILDER_START_ID
    ? { ...document, executable: { ...builderObject(document.executable), startStepId: '' } }
    : updateBuilderStep(document, source, { [port]: '' });
}

function nextId(document: BuilderDocument, prefix: string): string {
  const ids = new Set([
    ...builderSteps(document).map(({ id }) => id),
    ...document.notes.map(({ id }) => id),
    BUILDER_START_ID,
  ]);
  let index = 1;
  while (ids.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

export function addBuilderBlock(
  document: BuilderDocument,
  kind: BuilderBlockKind,
  after?: BuilderConnection,
): { document: BuilderDocument; id: string } {
  const id = nextId(
    document,
    kind === 'capabilityCall' ? 'capability' : kind === 'terminal' ? 'finish' : kind,
  );
  const position = {
    x:
      Math.max(
        360,
        ...Object.entries(document.layout).map(
          ([id, position]) =>
            position.x +
            builderBlockWidth(
              builderSteps(document).find((step) => step.id === id) ?? { kind: 'start' },
            ),
        ),
      ) + 80,
    y: 80,
  };
  if (kind === 'note')
    return {
      id,
      document: {
        ...document,
        notes: [...document.notes, { id, text: 'Add a note', ...position }],
      },
    };
  let step: BuilderStep;
  switch (kind) {
    case 'capabilityCall':
      step = {
        id,
        kind,
        capabilityVersionId: '',
        arguments: {},
        inputSchema: { required: {} },
        next: '',
      };
      break;
    case 'transform':
      step = { id, kind, arguments: {}, responseSchema: { required: {} }, next: '' };
      break;
    case 'condition':
      step = {
        id,
        kind,
        condition: {
          left: { source: 'literal', value: '' },
          operator: 'equals',
          right: { source: 'literal', value: '' },
        },
        whenTrue: '',
        whenFalse: '',
      };
      break;
    case 'sleep':
      step = { id, kind, durationMs: 60_000, next: '' };
      break;
    case 'terminal':
      step = { id, kind, state: 'completed', output: { source: 'literal', value: {} } };
      break;
  }
  let next: BuilderDocument = {
    ...document,
    executable: { ...builderObject(document.executable), steps: [...builderSteps(document), step] },
    layout: { ...document.layout, [id]: position },
  };
  if (after && kind !== 'terminal') {
    next = connectBuilder(next, { ...after, target: id });
    next = connectBuilder(next, {
      source: id,
      port: kind === 'condition' ? 'whenTrue' : 'next',
      target: after.target,
    });
    if (kind === 'condition')
      next = connectBuilder(next, { source: id, port: 'whenFalse', target: after.target });
  }
  return { document: next, id };
}

export function removeBuilderBlocks(
  document: BuilderDocument,
  ids: readonly string[],
): BuilderDocument {
  const removed = new Set(ids.filter((id) => id !== BUILDER_START_ID));
  const executable = builderObject(document.executable);
  const steps = builderSteps(document)
    .filter((step) => !removed.has(step.id))
    .map((step) => {
      const next = { ...step };
      for (const port of ['next', 'whenTrue', 'whenFalse'])
        if (typeof next[port] === 'string' && removed.has(next[port])) next[port] = '';
      return next;
    });
  // Keep references and compensation declarations intact so checks can identify broken links.
  return {
    ...document,
    executable: {
      ...executable,
      steps,
      ...(typeof executable.startStepId === 'string' && removed.has(executable.startStepId)
        ? { startStepId: '' }
        : {}),
    },
    layout: Object.fromEntries(Object.entries(document.layout).filter(([id]) => !removed.has(id))),
    labels: Object.fromEntries(Object.entries(document.labels).filter(([id]) => !removed.has(id))),
    notes: document.notes.filter(({ id }) => !removed.has(id)),
  };
}

export function duplicateBuilderBlock(
  document: BuilderDocument,
  stepId: string,
  capabilities: readonly BuilderCapability[] = [],
): { document: BuilderDocument; id: string } | undefined {
  const note = document.notes.find(({ id }) => id === stepId);
  const step = builderSteps(document).find(({ id }) => id === stepId);
  if (note) {
    const id = nextId(document, 'note');
    return {
      id,
      document: {
        ...document,
        notes: [...document.notes, { ...note, id, x: note.x + 35, y: note.y + 60 }],
      },
    };
  }
  if (!step || step.kind === 'compensation' || !builderStepEditable(step)) return undefined;
  const id = nextId(document, step.kind === 'terminal' ? 'finish' : step.kind);
  const copy: BuilderStep = { ...step, id };
  for (const port of ['next', 'whenTrue', 'whenFalse']) if (port in copy) copy[port] = '';
  const position = document.layout[stepId] ?? { x: 0, y: 0 };
  return {
    id,
    document: {
      ...document,
      executable: {
        ...builderObject(document.executable),
        steps: [...builderSteps(document), copy],
      },
      layout: { ...document.layout, [id]: { x: position.x + 35, y: position.y + 100 } },
      labels: {
        ...document.labels,
        [id]: `${builderStepLabel(document, step, capabilities)} copy`,
      },
    },
  };
}

export function builderStepTitle(step: BuilderStep): string {
  return (
    (
      {
        capabilityCall: 'Capability',
        publishEvent: 'Publish event',
        notify: 'Notify',
        transform: 'Set fields',
        condition: 'Conditional',
        sleep: 'Sleep',
        terminal: 'Finish',
        compensation: 'Compensation',
      } as Record<string, string>
    )[step.kind] ?? step.kind
  );
}

export function builderStepLabel(
  document: BuilderDocument,
  step: BuilderStep,
  capabilities: readonly BuilderCapability[] = [],
): string {
  const custom = document.labels[step.id]?.trim();
  if (custom) return custom;
  const capabilityId = builderText(step.capabilityVersionId);
  if (capabilityId) {
    const capability = capabilities.find((entry) => entry.capabilityVersionId === capabilityId);
    return capability?.label.trim() || step.id.replaceAll('_', ' ');
  }
  return builderStepTitle(step);
}

export function arrangeBuilder(document: BuilderDocument): BuilderDocument {
  const steps = builderSteps(document);
  const connections = builderConnections(document);
  const levels = new Map<string, number>([[BUILDER_START_ID, 0]]);
  const pending = [BUILDER_START_ID];
  while (pending.length) {
    const source = pending.shift();
    if (!source) continue;
    for (const edge of connections.filter((edge) => edge.source === source)) {
      if (levels.has(edge.target)) continue;
      levels.set(edge.target, (levels.get(source) ?? 0) + 1);
      pending.push(edge.target);
    }
  }
  const rows = new Map<number, number>();
  const widths = new Map<number, number>([[0, 360]]);
  for (const step of steps) {
    const level = levels.get(step.id) ?? 1;
    widths.set(level, Math.max(widths.get(level) ?? 0, builderBlockWidth(step)));
  }
  const columns = new Map<number, number>();
  let x = 45;
  for (let level = 0; level <= Math.max(...widths.keys()); level += 1) {
    columns.set(level, x);
    x += (widths.get(level) ?? 360) + 80;
  }
  const layout: BuilderDocument['layout'] = {};
  for (const id of [BUILDER_START_ID, ...steps.map(({ id }) => id)]) {
    const level = levels.get(id) ?? 1;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    layout[id] = { x: columns.get(level) ?? 45, y: row * 760 + 80 };
  }
  return { ...document, layout };
}

export function builderIssues(document: BuilderDocument): BuilderIssue[] {
  const reason = builderReadOnlyReason(document);
  if (reason) return [{ message: reason }];
  const issues: BuilderIssue[] = [];
  const steps = builderSteps(document);
  const ids = new Set(steps.map(({ id }) => id));
  const start = builderObject(document.executable).startStepId;
  if (typeof start !== 'string' || !ids.has(start))
    issues.push({ stepId: BUILDER_START_ID, message: 'Connect Start to a step.' });
  const reachable = new Set<string>();
  const pending = typeof start === 'string' ? [start] : [];
  const connections = builderConnections(document);
  while (pending.length) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...connections.filter((edge) => edge.source === id).map((edge) => edge.target));
  }
  for (const step of steps) {
    if (!builderStepEditable(step))
      issues.push({
        stepId: step.id,
        message: 'This step is preserved but cannot be edited here.',
      });
    if (step.kind === 'compensation') continue;
    if (!reachable.has(step.id))
      issues.push({ stepId: step.id, message: 'This step is not connected to Start.' });
    if (
      ['capabilityCall', 'publishEvent', 'notify'].includes(step.kind) &&
      !step.capabilityVersionId
    )
      issues.push({ stepId: step.id, message: 'Choose a capability.' });
    if (
      step.kind === 'sleep' &&
      (typeof step.durationMs !== 'number' ||
        !Number.isInteger(step.durationMs) ||
        step.durationMs <= 0 ||
        step.durationMs > 2_592_000_000)
    )
      issues.push({ stepId: step.id, message: 'Choose a positive duration of at most 30 days.' });
    if (step.kind !== 'terminal')
      for (const port of step.kind === 'condition' ? ['whenTrue', 'whenFalse'] : ['next']) {
        if (typeof step[port] !== 'string' || !ids.has(step[port]))
          issues.push({
            stepId: step.id,
            message: `Connect ${port === 'whenTrue' ? 'If true' : port === 'whenFalse' ? 'Otherwise' : 'Next'} to a step.`,
          });
      }
  }
  return issues;
}

function schemaOptions(
  schema: ObjectSchema,
  prefix: string,
  source: Record<string, unknown>,
): BuilderValueOption[] {
  const result: BuilderValueOption[] = [
    { label: `${prefix} · All fields`, type: 'object', value: { ...source, path: [] } },
  ];
  const walk = (fields: ObjectSchema['required'], path: string[]) => {
    for (const [name, field] of Object.entries(fields)) {
      const fieldPath = [...path, name];
      result.push({
        label: `${prefix} · ${fieldPath.join('.')}`,
        type: field.type,
        value: { ...source, path: fieldPath },
      });
      if (field.type === 'object') walk(field.required, fieldPath);
    }
  };
  walk(schema.required, []);
  return result;
}

export function builderValueOptions(
  document: BuilderDocument,
  stepId: string,
  capabilities: readonly BuilderCapability[] = [],
): BuilderValueOption[] {
  const connections = builderConnections(document);
  // Only offer outputs guaranteed on every path to this step. Branch-only values need an explicit fallback.
  const steps = builderSteps(document);
  const start = builderObject(document.executable).startStepId;
  const all = new Set(steps.filter((step) => step.kind !== 'compensation').map(({ id }) => id));
  const dominators = new Map<string, Set<string>>();
  for (const id of all) dominators.set(id, id === start ? new Set([id]) : new Set(all));
  for (let iteration = 0; iteration <= all.size; iteration += 1) {
    let changed = false;
    for (const id of all) {
      if (id === start) continue;
      const parents = connections
        .filter((edge) => edge.target === id && all.has(edge.source))
        .map((edge) => edge.source);
      const common = parents.length
        ? new Set(dominators.get(parents[0]!) ?? [])
        : new Set<string>();
      for (const parent of parents.slice(1))
        for (const candidate of common)
          if (!dominators.get(parent)?.has(candidate)) common.delete(candidate);
      common.add(id);
      if ([...common].join('|') !== [...(dominators.get(id) ?? [])].join('|')) {
        dominators.set(id, common);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const available = dominators.get(stepId) ?? new Set<string>();
  const options = schemaOptions(
    builderSchema(builderObject(document.executable).inputSchema),
    'Start',
    { source: 'input' },
  );
  options.push({
    label: 'Run · Workflow run ID',
    type: 'string',
    value: { source: 'input', path: ['atlasWorkflowRunId'] },
  });
  for (const step of steps) {
    if (step.id === stepId || !available.has(step.id)) continue;
    options.push(
      ...schemaOptions(
        builderSchema(step.responseSchema),
        builderStepLabel(document, step, capabilities),
        { source: 'stepOutput', stepId: step.id },
      ),
    );
  }
  return options;
}

function projectedValueSchema(
  fragment: Record<string, unknown>,
  value: unknown,
  seen = new Set<string>(),
): ResponseValueSchema | undefined {
  const schema = builderObject(value);
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return undefined;
    seen = new Set([...seen, schema.$ref]);
    return projectedValueSchema(fragment, builderObject(fragment.references)[schema.$ref], seen);
  }
  const rawClassification = schema['x-atlas-data-classification'];
  const classification: Pick<ResponseValueSchema, 'classification'> =
    rawClassification === 'public' ||
    rawClassification === 'internal' ||
    rawClassification === 'confidential' ||
    rawClassification === 'secret' ||
    rawClassification === 'restricted'
      ? { classification: rawClassification }
      : {};
  const type: unknown = Array.isArray(schema.type)
    ? schema.type.find((type) => type !== 'null')
    : schema.type;
  if (type === 'object' || schema.properties) {
    const fields: Record<string, ResponseValueSchema> = {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, child] of Object.entries(builderObject(schema.properties))) {
      if (!required.has(name)) continue;
      const field = projectedValueSchema(fragment, child, seen);
      if (field) fields[name] = field;
    }
    return { type: 'object', required: fields, ...classification };
  }
  if (type === 'array') {
    const items = projectedValueSchema(fragment, schema.items, seen);
    return items ? { type, items, ...classification } : undefined;
  }
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'integer' ||
    type === 'boolean' ||
    type === 'null'
  )
    return { type, ...classification };
  return undefined;
}

export function builderCapabilitiesFromProjection(projection: unknown): BuilderCapability[] {
  const capabilities = builderObject(projection).capabilities;
  if (!Array.isArray(capabilities)) return [];
  return capabilities.flatMap((candidate) => {
    const capability = builderObject(candidate);
    if (typeof capability.capabilityVersionId !== 'string') return [];
    const observation = readCapabilityObservation(capability.observation);
    const identity = builderObject(capability.identity);
    const fragment = builderObject(capability.fragment);
    const operation = builderObject(fragment.operation);
    const input: Record<string, ResponseValueSchema> = {};
    const parameters = [
      ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ];
    for (const candidate of parameters) {
      const parameter = builderObject(candidate);
      const field = projectedValueSchema(fragment, parameter.schema);
      if (parameter.required === true && typeof parameter.name === 'string' && field)
        input[parameter.name] = field;
    }
    const body = builderObject(
      Object.values(builderObject(builderObject(operation.requestBody).content))[0],
    ).schema;
    const channelMessages = builderObject(builderObject(fragment.channel).messages);
    const messageRef = (Array.isArray(operation.messages) ? operation.messages : [])
      .map(builderObject)
      .find((message) => typeof message.$ref === 'string');
    const message =
      messageRef && typeof messageRef.$ref === 'string'
        ? builderObject(channelMessages[messageRef.$ref.split('/').at(-1) ?? ''])
        : builderObject(fragment.message);
    const bodySchema = projectedValueSchema(fragment, body ?? message.payload);
    if (bodySchema?.type === 'object') Object.assign(input, bodySchema.required);
    const response = Object.entries(builderObject(operation.responses))
      .sort(([a], [b]) => a.localeCompare(b))
      .find(([status]) => /^2\d\d$/.test(status))?.[1];
    const outputSchema = projectedValueSchema(
      fragment,
      builderObject(Object.values(builderObject(builderObject(response).content))[0]).schema,
    );
    return [
      {
        capabilityVersionId: capability.capabilityVersionId,
        ...(observation ? { observation } : {}),
        label: `${typeof identity.serviceId === 'string' ? identity.serviceId + ' / ' : ''}${builderText(identity.operationId, capability.capabilityVersionId)}`,
        description:
          typeof operation.summary === 'string'
            ? operation.summary
            : typeof operation.description === 'string'
              ? operation.description
              : '',
        kind:
          identity.kind === 'asyncapi' ? ('publishEvent' as const) : ('capabilityCall' as const),
        inputSchema: { required: input },
        responseSchema:
          outputSchema?.type === 'object' ? { required: outputSchema.required } : { required: {} },
      },
    ];
  });
}
