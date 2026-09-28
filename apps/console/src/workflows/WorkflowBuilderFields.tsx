import { useId, useState } from 'react';
import {
  objectSchemaSchema,
  type ObjectSchema,
  type ResponseValueSchema,
} from '@atlas/workflow-ir';

import {
  builderObject,
  builderText,
  type BuilderCapability,
  type BuilderValueOption,
} from './builder-model.js';
import {
  lastKnownDefinitionMessage,
  usesLastKnownDefinition,
} from './capability-definition-status.js';

export function BuilderCapabilityField({
  capabilityVersionId,
  capabilities,
  disabled,
  onSelect,
}: {
  capabilityVersionId: string;
  capabilities: readonly BuilderCapability[];
  disabled: boolean;
  onSelect: (capability: BuilderCapability) => void;
}) {
  const id = useId();
  const selected = capabilities.find(
    (capability) => capability.capabilityVersionId === capabilityVersionId,
  );
  const lastKnown = usesLastKnownDefinition(selected?.observation);
  return (
    <>
      <label htmlFor={id}>Authorized capability</label>
      <select
        className="nodrag"
        id={id}
        disabled={disabled}
        value={capabilityVersionId}
        aria-describedby={lastKnown ? `${id}-definition` : undefined}
        onChange={(event) => {
          const capability = capabilities.find(
            (capability) => capability.capabilityVersionId === event.target.value,
          );
          if (capability) onSelect(capability);
        }}
      >
        <option value="" disabled>
          Choose a capability…
        </option>
        {capabilityVersionId && !selected && (
          <option value={capabilityVersionId}>Saved capability · unavailable</option>
        )}
        {capabilities.map((capability) => (
          <option key={capability.capabilityVersionId} value={capability.capabilityVersionId}>
            {capability.label}
            {usesLastKnownDefinition(capability.observation) ? ' · Last known definition' : ''}
          </option>
        ))}
      </select>
      {lastKnown && (
        <p className="wb-definition-note" id={`${id}-definition`} role="status">
          {lastKnownDefinitionMessage}
        </p>
      )}
      {!capabilities.length && (
        <p className="wb-help">No authorized capabilities are available in this environment.</p>
      )}
      {capabilityVersionId && !selected && (
        <p className="wb-help">
          The saved capability and its settings are preserved. Workflow checks will verify whether
          it can still run.
        </p>
      )}
    </>
  );
}

export function BuilderJsonField({
  label,
  value,
  onChange,
  disabled = false,
  validate,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  validate?: (value: unknown) => string | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <div className="wb-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        className="nodrag"
        id={id}
        disabled={disabled}
        spellCheck={false}
        rows={5}
        value={draft ?? JSON.stringify(value, null, 2) ?? ''}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          try {
            const parsed: unknown = JSON.parse(text);
            const issue = validate?.(parsed);
            if (issue) {
              setError(issue);
              return;
            }
            setError(undefined);
            onChange(parsed);
          } catch {
            setError('Enter valid JSON. Your last valid value is kept until this is fixed.');
          }
        }}
        onBlur={() => {
          if (!error) setDraft(undefined);
        }}
      />
      {error && (
        <p id={`${id}-error`} className="wb-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function defaultLiteral(type: string): unknown {
  return type === 'boolean'
    ? false
    : type === 'number' || type === 'integer'
      ? 0
      : type === 'object'
        ? {}
        : type === 'array'
          ? []
          : type === 'null'
            ? null
            : '';
}

export function BuilderExpressionField({
  label,
  value,
  options,
  onChange,
  expectedType,
  disabled = false,
  allowTransform = false,
}: {
  label: string;
  value: unknown;
  options: readonly BuilderValueOption[];
  onChange: (value: unknown) => void;
  expectedType?: string;
  disabled?: boolean;
  allowTransform?: boolean;
}) {
  const id = useId();
  const expression = builderObject(value);
  const literal = expression.source === 'literal';
  const reference = expression.source === 'input' || expression.source === 'stepOutput';
  const simple = literal || reference || value === undefined;
  const type =
    expectedType ??
    (literal
      ? Array.isArray(expression.value)
        ? 'array'
        : expression.value === null
          ? 'null'
          : typeof expression.value
      : 'string');
  const [constantType, setConstantType] = useState(type);
  const [numberDraft, setNumberDraft] = useState<string>();
  const choices = options.filter(
    (option) =>
      !expectedType ||
      option.type === expectedType ||
      (expectedType === 'number' && option.type === 'integer'),
  );
  const selected = choices.findIndex(
    (option) => JSON.stringify(option.value) === JSON.stringify(value),
  );
  return (
    <div className="wb-expression">
      <label htmlFor={id}>
        {label}
        {expectedType && <span className="wb-type">{expectedType}</span>}
      </label>
      {simple ? (
        <>
          <select
            className="nodrag"
            id={id}
            disabled={disabled}
            value={
              literal
                ? 'constant'
                : reference
                  ? selected >= 0
                    ? String(selected)
                    : 'unavailable'
                  : ''
            }
            onChange={(event) => {
              if (event.target.value === 'constant')
                onChange({
                  source: 'literal',
                  value: defaultLiteral(expectedType ?? constantType),
                });
              else {
                const option = choices[Number(event.target.value)];
                if (option) onChange(option.value);
              }
            }}
          >
            <option value="" disabled>
              Choose a value
            </option>
            <option value="constant">Fixed value</option>
            {reference && selected < 0 && (
              <option value="unavailable">Saved reference · check its source</option>
            )}
            {choices.length > 0 && (
              <optgroup label="Earlier outputs">
                {choices.map((option, index) => (
                  <option value={index} key={JSON.stringify(option.value)}>
                    {option.label} ({option.type})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          {reference && selected < 0 && (
            <p className="wb-help">
              This saved reference is preserved. Connect its source on every route to use it safely.
            </p>
          )}
          {literal && (
            <>
              {!expectedType && (
                <select
                  className="nodrag"
                  aria-label={`${label} value type`}
                  disabled={disabled}
                  value={type}
                  onChange={(event) => {
                    setConstantType(event.target.value);
                    onChange({ source: 'literal', value: defaultLiteral(event.target.value) });
                  }}
                >
                  {['string', 'number', 'boolean', 'object', 'array', 'null'].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              )}
              {type === 'boolean' ? (
                <select
                  className="nodrag"
                  aria-label={`${label} fixed value`}
                  disabled={disabled}
                  value={builderText(expression.value)}
                  onChange={(event) =>
                    onChange({ source: 'literal', value: event.target.value === 'true' })
                  }
                >
                  <option value="false">False</option>
                  <option value="true">True</option>
                </select>
              ) : type === 'object' || type === 'array' ? (
                <BuilderJsonField
                  label={`${label} fixed value`}
                  value={expression.value}
                  disabled={disabled}
                  onChange={(value) => onChange({ source: 'literal', value })}
                  validate={(value) =>
                    type === 'array'
                      ? Array.isArray(value)
                        ? undefined
                        : 'Enter a JSON array.'
                      : value !== null && typeof value === 'object' && !Array.isArray(value)
                        ? undefined
                        : 'Enter a JSON object.'
                  }
                />
              ) : type === 'null' ? (
                <span className="wb-help">No value (null)</span>
              ) : (
                <input
                  className="nodrag"
                  aria-label={`${label} fixed value`}
                  disabled={disabled}
                  type={type === 'number' || type === 'integer' ? 'number' : 'text'}
                  step={type === 'integer' ? 1 : 'any'}
                  value={numberDraft ?? builderText(expression.value)}
                  onChange={(event) => {
                    const text = event.target.value;
                    if (type === 'number' || type === 'integer') {
                      setNumberDraft(text);
                      if (text !== '' && Number.isFinite(Number(text)))
                        onChange({ source: 'literal', value: Number(text) });
                    } else onChange({ source: 'literal', value: text });
                  }}
                  onBlur={() => setNumberDraft(undefined)}
                />
              )}
            </>
          )}
        </>
      ) : expression.kind === 'call' &&
        ['uppercase', 'lowercase', 'concat', 'default', 'divide', 'multiply', 'exists'].includes(
          builderText(expression.function),
        ) &&
        Array.isArray(expression.arguments) ? (
        <>
          <p className="wb-help">{builderText(expression.function)} transformation</p>
          {expression.arguments.map((argument, index) => (
            <BuilderExpressionField
              key={index}
              label={`Value ${index + 1}`}
              value={argument}
              options={options}
              disabled={disabled}
              onChange={(updated) =>
                onChange({
                  ...expression,
                  arguments: (expression.arguments as unknown[]).map((value, at) =>
                    at === index ? updated : value,
                  ),
                })
              }
            />
          ))}
          <button
            type="button"
            className="wb-text-button nodrag"
            disabled={disabled}
            onClick={() => onChange((expression.arguments as unknown[])[0])}
          >
            Remove transformation
          </button>
        </>
      ) : (
        <>
          <p className="wb-help">
            This saved expression is preserved. Edit its structured fields below.
          </p>
          <BuilderJsonField
            label={`${label} expression`}
            value={value}
            disabled={disabled}
            onChange={onChange}
          />
        </>
      )}
      {allowTransform && simple && value !== undefined && (
        <select
          className="nodrag"
          aria-label={`Transform ${label}`}
          disabled={disabled}
          value=""
          onChange={(event) => {
            const fn = event.target.value;
            if (!fn) return;
            onChange({
              kind: 'call',
              function: fn,
              arguments: ['uppercase', 'lowercase', 'exists'].includes(fn)
                ? [value]
                : [
                    value,
                    { source: 'literal', value: fn === 'multiply' || fn === 'divide' ? 1 : '' },
                  ],
            });
          }}
        >
          <option value="">Add a transformation…</option>
          <option value="uppercase">Uppercase</option>
          <option value="lowercase">Lowercase</option>
          <option value="concat">Join text</option>
          <option value="default">Fallback value</option>
          <option value="multiply">Multiply</option>
          <option value="divide">Divide</option>
          <option value="exists">Has a value</option>
        </select>
      )}
    </div>
  );
}

export function BuilderSchemaField({
  schema,
  onChange,
  disabled = false,
  label = 'Input fields',
}: {
  schema: ObjectSchema;
  onChange: (schema: ObjectSchema) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('string');
  const [error, setError] = useState<string>();
  return (
    <div className="wb-schema">
      <h4>{label}</h4>
      {Object.entries(schema.required).map(([name, field]) => (
        <div className="wb-schema-row" key={name}>
          <span>
            {name}
            <small>{field.type}</small>
          </span>
          <button
            className="nodrag"
            type="button"
            aria-label={`Remove field ${name}`}
            disabled={disabled}
            onClick={() =>
              onChange({
                required: Object.fromEntries(
                  Object.entries(schema.required).filter(([key]) => key !== name),
                ),
              })
            }
          >
            ×
          </button>
        </div>
      ))}
      {!Object.keys(schema.required).length && <p className="wb-help">No fields yet.</p>}
      <div className="wb-add-field">
        <input
          className="nodrag"
          aria-label={`New ${label.toLowerCase()} name`}
          placeholder="Field name"
          disabled={disabled}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="nodrag"
          aria-label="New field type"
          disabled={disabled}
          value={type}
          onChange={(event) => setType(event.target.value)}
        >
          {['string', 'number', 'integer', 'boolean', 'object', 'array'].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <button
          className="nodrag"
          type="button"
          disabled={disabled || !name.trim()}
          onClick={() => {
            if (Object.hasOwn(schema.required, name.trim())) {
              setError('A field already uses that name.');
              return;
            }
            const field: ResponseValueSchema =
              type === 'object'
                ? { type, required: {} }
                : type === 'array'
                  ? { type, items: { type: 'string' } }
                  : { type: type as 'string' | 'number' | 'integer' | 'boolean' };
            onChange({ required: { ...schema.required, [name.trim()]: field } });
            setName('');
            setError(undefined);
          }}
        >
          Add field
        </button>
      </div>
      {error && (
        <p className="wb-error" role="alert">
          {error}
        </p>
      )}
      <details>
        <summary className="nodrag">Nested fields and types</summary>
        <BuilderJsonField
          label={`${label} schema`}
          value={schema}
          disabled={disabled}
          onChange={(value) => {
            const result = objectSchemaSchema.safeParse(value);
            if (result.success) onChange(result.data);
          }}
          validate={(value) =>
            objectSchemaSchema.safeParse(value).success
              ? undefined
              : 'Use a required-fields object with valid field types.'
          }
        />
      </details>
    </div>
  );
}
