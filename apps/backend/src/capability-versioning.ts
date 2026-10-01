import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { JsonObject } from './capability-documents.js';

const jsonObjectSchema = z.record(z.string(), z.unknown());

export type ChangeClassification = 'compatible' | 'conditional' | 'breaking' | 'metadata';

// OpenAPI and AsyncAPI define these as annotations: they add human-facing context but do not
// change the shape of the declared request, response, or message contract Atlas compares.
const annotationKeys = new Set([
  '$comment',
  'description',
  'example',
  'examples',
  'externalDocs',
  'summary',
  'tags',
  'title',
]);

const namedEntryMaps = new Set([
  '$defs',
  'content',
  'definitions',
  'dependentSchemas',
  'headers',
  'patternProperties',
  'properties',
  'references',
  'responses',
]);

// Values beneath these keywords are payload data, not nested schema objects.
const literalValueKeys = new Set(['const', 'enum', 'default']);

function withoutAnnotations(value: unknown, preserveEntryNames = false): unknown {
  if (Array.isArray(value)) return value.map((child) => withoutAnnotations(child));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(([key]) => preserveEntryNames || !annotationKeys.has(key))
      .map(([key, child]) => [
        key,
        !preserveEntryNames && literalValueKeys.has(key)
          ? child
          : withoutAnnotations(child, !preserveEntryNames && namedEntryMaps.has(key)),
      ]),
  );
}

function hasOnlyCompatibleSchemaAdditions(
  previous: unknown,
  next: unknown,
  allowAddedEntries = false,
): boolean {
  if (canonicalJson(previous) === canonicalJson(next)) return true;
  if (
    !previous ||
    typeof previous !== 'object' ||
    !next ||
    typeof next !== 'object' ||
    Array.isArray(previous) ||
    Array.isArray(next)
  ) {
    return false;
  }
  const before = previous as JsonObject;
  const after = next as JsonObject;
  for (const [key, value] of Object.entries(before)) {
    if (
      !(key in after) ||
      !hasOnlyCompatibleSchemaAdditions(value, after[key], key === 'properties')
    ) {
      return false;
    }
  }
  return allowAddedEntries || Object.keys(after).every((key) => key in before);
}

interface FieldChange {
  readonly kind: 'added-optional' | 'added-required' | 'removed' | 'retyped' | 'renamed';
  readonly path: string;
  readonly fromPath?: string;
  readonly classification: ChangeClassification;
}

export interface CapabilitySafety {
  readonly idempotencyField: string | null;
  readonly compensatedByIdentityId: string | null;
  readonly irreversibleAfter: boolean;
}

export interface CapabilitySafetyChange {
  readonly kind: 'idempotency-changed' | 'compensation-changed' | 'irreversibility-changed';
  readonly classification: 'compatible' | 'breaking';
  readonly previousValue: string | boolean | null;
  readonly nextValue: string | boolean | null;
}

export function capabilitySafetyChanges(
  previous: CapabilitySafety,
  next: CapabilitySafety,
): CapabilitySafetyChange[] {
  const changes: CapabilitySafetyChange[] = [];
  if (previous.idempotencyField !== next.idempotencyField) {
    changes.push({
      kind: 'idempotency-changed',
      classification:
        previous.idempotencyField !== null && previous.idempotencyField !== next.idempotencyField
          ? 'breaking'
          : 'compatible',
      previousValue: previous.idempotencyField,
      nextValue: next.idempotencyField,
    });
  }
  if (previous.compensatedByIdentityId !== next.compensatedByIdentityId) {
    changes.push({
      kind: 'compensation-changed',
      classification:
        previous.compensatedByIdentityId !== null &&
        previous.compensatedByIdentityId !== next.compensatedByIdentityId
          ? 'breaking'
          : 'compatible',
      previousValue: previous.compensatedByIdentityId,
      nextValue: next.compensatedByIdentityId,
    });
  }
  if (previous.irreversibleAfter !== next.irreversibleAfter) {
    changes.push({
      kind: 'irreversibility-changed',
      classification:
        !previous.irreversibleAfter && next.irreversibleAfter ? 'breaking' : 'compatible',
      previousValue: previous.irreversibleAfter,
      nextValue: next.irreversibleAfter,
    });
  }
  return changes;
}

export interface ApprovedFieldRename {
  readonly schema: string;
  readonly from: string;
  readonly to: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function hasBreakingSchemaChange(previous: unknown, next: unknown): boolean {
  if (!previous || typeof previous !== 'object' || !next || typeof next !== 'object') {
    return canonicalJson(previous) !== canonicalJson(next);
  }
  const before = previous as JsonObject;
  const after = next as JsonObject;
  if (before.type !== after.type) return true;
  if (
    Object.hasOwn(after, 'const') &&
    (!Object.hasOwn(before, 'const') || canonicalJson(before.const) !== canonicalJson(after.const))
  )
    return true;
  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    const afterEnum = new Set(after.enum.map(canonicalJson));
    if (before.enum.some((value) => !afterEnum.has(canonicalJson(value)))) return true;
  }
  const beforeRequired = Array.isArray(before.required) ? before.required : [];
  const afterRequired = Array.isArray(after.required) ? after.required : [];
  if (afterRequired.some((name) => !beforeRequired.includes(name))) return true;
  const beforeProperties = before.properties;
  const afterProperties = after.properties;
  if (beforeProperties && typeof beforeProperties === 'object') {
    if (!afterProperties || typeof afterProperties !== 'object') return true;
    for (const [name, schema] of Object.entries(beforeProperties as JsonObject)) {
      if (!(name in (afterProperties as JsonObject))) return true;
      if (hasBreakingSchemaChange(schema, (afterProperties as JsonObject)[name])) return true;
    }
  }
  return false;
}

function changedJsonPointers(previous: unknown, next: unknown, path = ''): string[] {
  if (canonicalJson(previous) === canonicalJson(next)) return [];
  if (
    !previous ||
    typeof previous !== 'object' ||
    !next ||
    typeof next !== 'object' ||
    Array.isArray(previous) ||
    Array.isArray(next)
  ) {
    return [path || '/'];
  }
  const keys = new Set([
    ...Object.keys(previous as JsonObject),
    ...Object.keys(next as JsonObject),
  ]);
  return [...keys].flatMap((key) =>
    changedJsonPointers(
      (previous as JsonObject)[key],
      (next as JsonObject)[key],
      `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    ),
  );
}

function jsonPointer(path: string, key: string) {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function schemaFieldChanges(
  previous: unknown,
  next: unknown,
  path: string,
  approvedRenames: readonly ApprovedFieldRename[],
): FieldChange[] {
  if (!previous || typeof previous !== 'object' || !next || typeof next !== 'object') return [];
  const before = previous as JsonObject;
  const after = next as JsonObject;
  const beforeProperties = jsonObjectSchema.safeParse(before.properties);
  const afterProperties = jsonObjectSchema.safeParse(after.properties);
  const changes: FieldChange[] = [];
  if (beforeProperties.success || afterProperties.success) {
    const previousFields = beforeProperties.success ? beforeProperties.data : {};
    const nextFields = afterProperties.success ? afterProperties.data : {};
    const nextRequired = new Set(Array.isArray(after.required) ? after.required : []);
    const renamedFrom = new Set<string>();
    const renamedTo = new Set<string>();
    for (const rename of approvedRenames) {
      const schemaPath = jsonPointer('/references', rename.schema);
      if (path !== schemaPath || !(rename.from in previousFields) || !(rename.to in nextFields)) {
        continue;
      }
      const previousSchema = jsonObjectSchema.safeParse(previousFields[rename.from]);
      const nextSchema = jsonObjectSchema.safeParse(nextFields[rename.to]);
      if (
        !previousSchema.success ||
        !nextSchema.success ||
        canonicalJson(previousSchema.data.type) !== canonicalJson(nextSchema.data.type)
      ) {
        continue;
      }
      renamedFrom.add(rename.from);
      renamedTo.add(rename.to);
      changes.push({
        kind: 'renamed',
        fromPath: jsonPointer(jsonPointer(path, 'properties'), rename.from),
        path: jsonPointer(jsonPointer(path, 'properties'), rename.to),
        classification: 'conditional',
      });
    }
    for (const [name, schema] of Object.entries(previousFields)) {
      if (renamedFrom.has(name)) continue;
      const fieldPath = jsonPointer(jsonPointer(path, 'properties'), name);
      if (!(name in nextFields)) {
        changes.push({ kind: 'removed', path: fieldPath, classification: 'breaking' });
        continue;
      }
      const nextSchema = nextFields[name];
      const previousType = jsonObjectSchema.safeParse(schema).success
        ? (schema as JsonObject).type
        : undefined;
      const nextType = jsonObjectSchema.safeParse(nextSchema).success
        ? (nextSchema as JsonObject).type
        : undefined;
      if (canonicalJson(previousType) !== canonicalJson(nextType)) {
        changes.push({ kind: 'retyped', path: fieldPath, classification: 'breaking' });
      } else {
        changes.push(...schemaFieldChanges(schema, nextSchema, fieldPath, approvedRenames));
      }
    }
    for (const name of Object.keys(nextFields)) {
      if (name in previousFields || renamedTo.has(name)) continue;
      const required = nextRequired.has(name);
      changes.push({
        kind: required ? 'added-required' : 'added-optional',
        path: jsonPointer(jsonPointer(path, 'properties'), name),
        classification: required ? 'breaking' : 'compatible',
      });
    }
  }
  for (const [key, value] of Object.entries(before)) {
    if (key === 'properties' || key === 'required' || !(key in after)) continue;
    changes.push(...schemaFieldChanges(value, after[key], jsonPointer(path, key), approvedRenames));
  }
  return changes;
}

function worstClassification(classifications: readonly ChangeClassification[]) {
  if (classifications.includes('breaking')) return 'breaking' as const;
  if (classifications.includes('conditional')) return 'conditional' as const;
  if (classifications.includes('compatible')) return 'compatible' as const;
  if (classifications.includes('metadata')) return 'metadata' as const;
  return 'compatible' as const;
}

function normalizeApprovedRenames(
  previous: JsonObject,
  next: JsonObject,
  approvedRenames: readonly ApprovedFieldRename[],
) {
  const normalized = structuredClone(previous);
  const previousReferences = normalized.references as JsonObject | undefined;
  if (!previousReferences) return normalized;
  const nextReferences = jsonObjectSchema.parse(next.references ?? {});
  for (const rename of approvedRenames) {
    const previousSchemaValue = previousReferences[rename.schema];
    const previousSchema = jsonObjectSchema.safeParse(previousSchemaValue);
    const nextSchema = jsonObjectSchema.safeParse(nextReferences[rename.schema]);
    if (!previousSchema.success || !nextSchema.success) continue;
    const previousPropertiesValue = (previousSchemaValue as JsonObject).properties;
    const previousProperties = jsonObjectSchema.safeParse(previousPropertiesValue);
    const nextProperties = jsonObjectSchema.safeParse(nextSchema.data.properties);
    if (
      !previousProperties.success ||
      !nextProperties.success ||
      !(rename.from in previousProperties.data) ||
      !(rename.to in nextProperties.data)
    ) {
      continue;
    }
    const fromSchema = jsonObjectSchema.safeParse(previousProperties.data[rename.from]);
    const toSchema = jsonObjectSchema.safeParse(nextProperties.data[rename.to]);
    if (
      !fromSchema.success ||
      !toSchema.success ||
      canonicalJson(fromSchema.data.type) !== canonicalJson(toSchema.data.type)
    ) {
      continue;
    }
    const mutableProperties = previousPropertiesValue as JsonObject;
    mutableProperties[rename.to] = mutableProperties[rename.from];
    delete mutableProperties[rename.from];
    const mutableSchema = previousSchemaValue as JsonObject;
    if (Array.isArray(mutableSchema.required)) {
      mutableSchema.required = mutableSchema.required.map((name) =>
        name === rename.from ? rename.to : name,
      );
    }
  }
  return normalized;
}

function hasBreakingStructureChange(previous: unknown, next: unknown): boolean {
  if (canonicalJson(previous) === canonicalJson(next)) return false;
  if (Array.isArray(previous) || Array.isArray(next)) return true;
  if (!previous || typeof previous !== 'object' || !next || typeof next !== 'object') {
    return true;
  }
  const before = previous as JsonObject;
  const after = next as JsonObject;
  for (const [key, value] of Object.entries(before)) {
    if (!(key in after) || hasBreakingStructureChange(value, after[key])) return true;
  }
  return false;
}

export function compatibilityDiff(
  previous: JsonObject,
  next: JsonObject,
  approvedRenames: readonly ApprovedFieldRename[] = [],
) {
  const changes = changedJsonPointers(previous, next);
  const fieldChanges = schemaFieldChanges(previous, next, '', approvedRenames);
  if (changes.length === 0) {
    return { classification: 'compatible', changes, fieldChanges } as const;
  }
  if (canonicalJson(withoutAnnotations(previous)) === canonicalJson(withoutAnnotations(next))) {
    return { classification: 'metadata', changes, fieldChanges } as const;
  }
  const structuralPrevious = normalizeApprovedRenames(previous, next, approvedRenames);
  const previousReferences = jsonObjectSchema.parse(structuralPrevious.references ?? {});
  const nextReferences = jsonObjectSchema.parse(next.references ?? {});
  let structuralClassification: ChangeClassification = 'compatible';
  for (const [reference, schema] of Object.entries(previousReferences)) {
    if (!(reference in nextReferences)) {
      structuralClassification = 'breaking';
      break;
    }
    const nextSchema = nextReferences[reference];
    if (hasBreakingSchemaChange(schema, nextSchema)) {
      structuralClassification = 'breaking';
      break;
    }
    const structuralSchema = withoutAnnotations(schema);
    const structuralNextSchema = withoutAnnotations(nextSchema);
    if (
      canonicalJson(structuralSchema) !== canonicalJson(structuralNextSchema) &&
      !hasOnlyCompatibleSchemaAdditions(structuralSchema, structuralNextSchema)
    ) {
      structuralClassification = 'conditional';
    }
  }
  const { references: _previousReferences, ...previousCapability } = structuralPrevious;
  const { references: _nextReferences, ...nextCapability } = next;
  const structuralPreviousCapability = withoutAnnotations(previousCapability);
  const structuralNextCapability = withoutAnnotations(nextCapability);
  let capabilityClassification: ChangeClassification = 'compatible';
  if (structuralClassification !== 'breaking') {
    capabilityClassification = hasBreakingStructureChange(
      structuralPreviousCapability,
      structuralNextCapability,
    )
      ? 'breaking'
      : canonicalJson(structuralPreviousCapability) === canonicalJson(structuralNextCapability)
        ? 'compatible'
        : 'conditional';
  }
  return {
    classification: worstClassification([
      structuralClassification,
      capabilityClassification,
      ...fieldChanges.map(({ classification }) => classification),
    ]),
    changes,
    fieldChanges,
  } as const;
}
