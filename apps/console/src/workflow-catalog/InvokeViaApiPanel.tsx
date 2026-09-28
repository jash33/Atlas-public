import { customerAuth } from '../config.js';
import { validateWorkflowInput, type JsonValue, type ObjectSchema } from '@atlas/workflow-ir';
import { useState } from 'react';

import { environmentLabels, type EnvironmentId } from '../shell/session.js';

export const localIngestCallerToken = customerAuth
  ? ''
  : (import.meta.env.VITE_ATLAS_INGEST_CALLER_TOKEN ?? '');

export interface IngestPayloadField {
  path: string;
  type: string;
}

export function ingestGatewayOrigin(environmentId: EnvironmentId): string {
  return environmentId === 'production' ? 'http://localhost:4301' : 'http://localhost:4300';
}

export function ingestGatewayUrl(environmentId: EnvironmentId): string {
  return `${ingestGatewayOrigin(environmentId)}/ingest`;
}

export function describeIngestPayloadFields(
  inputSchema: ObjectSchema | null,
): IngestPayloadField[] {
  if (!inputSchema) return [];
  return collectPayloadFields(inputSchema.required, '');
}

export function buildIngestSampleBody(
  workflowName: string,
  payload: Record<string, JsonValue>,
): string {
  return JSON.stringify(
    {
      workflowName,
      payload,
    },
    null,
    2,
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildIngestSampleCurl(
  workflowName: string,
  environmentId: EnvironmentId,
  payload: Record<string, JsonValue>,
): string {
  return [
    `curl -X POST ${ingestGatewayUrl(environmentId)} \\`,
    `  -H "Authorization: Bearer ${localIngestCallerToken}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellSingleQuote(buildIngestSampleBody(workflowName, payload))}`,
  ].join('\n');
}

function collectPayloadFields(
  required: ObjectSchema['required'] | undefined,
  prefix: string,
): IngestPayloadField[] {
  if (!required || typeof required !== 'object') return [];
  return Object.entries(required).flatMap(([name, fieldSchema]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    if (fieldSchema.type === 'object') {
      return [{ path, type: 'object' }, ...collectPayloadFields(fieldSchema.required, path)];
    }
    if (fieldSchema.type === 'array') {
      if (fieldSchema.items.type === 'object') {
        return [
          { path, type: 'array of object' },
          ...collectPayloadFields(fieldSchema.items.required, `${path}[]`),
        ];
      }
      return [{ path, type: `array of ${fieldSchema.items.type}` }];
    }
    return [{ path, type: fieldSchema.type }];
  });
}

export function InvokeViaApiPanel({
  environmentId,
  inputSchema,
  invocationExample,
  workflowName,
}: {
  environmentId: EnvironmentId;
  inputSchema: ObjectSchema | null;
  invocationExample?: Record<string, JsonValue> | null;
  workflowName: string;
}) {
  const [copied, setCopied] = useState(false);
  const [editedPayload, setEditedPayload] = useState<string | null>(null);
  const sourceExample = environmentId === 'development' ? invocationExample : null;
  const payloadText = editedPayload ?? JSON.stringify(sourceExample ?? {}, null, 2);
  let payload: Record<string, JsonValue> | null = null;
  let payloadError = 'An active input schema is required.';
  try {
    const candidate: unknown = JSON.parse(payloadText);
    const issues = inputSchema ? validateWorkflowInput(candidate, inputSchema) : [];
    if (inputSchema && issues.length === 0) payload = candidate as Record<string, JsonValue>;
    else if (issues.length)
      payloadError = issues.map((issue) => `${issue.path}: ${issue.message}`).join(' ');
  } catch {
    payloadError = 'Enter a valid JSON payload.';
  }
  const sampleCurl = payload ? buildIngestSampleCurl(workflowName, environmentId, payload) : '';
  const sampleBody = payload ? buildIngestSampleBody(workflowName, payload) : '';
  const gatewayUrl = ingestGatewayUrl(environmentId);
  const payloadFields = describeIngestPayloadFields(inputSchema);

  async function copySample() {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(customerAuth ? sampleBody : sampleCurl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-label="Invoke via API" className="wfd-invoke">
      <header className="wfd-section-heading">
        <div>
          <p>Ingest gateway · {environmentLabels[environmentId]}</p>
          <h2>Invoke via API</h2>
        </div>
        <button
          className="wfc-create"
          disabled={!payload}
          onClick={() => void copySample()}
          type="button"
        >
          {copied ? 'Copied' : customerAuth ? 'Copy request body' : 'Copy sample request'}
        </button>
      </header>
      <p>
        Start this workflow by posting plaintext JSON to the {environmentLabels[environmentId]}{' '}
        ingest gateway. Organization and environment come from gateway configuration. Use the
        workflow&apos;s exact name as <code>workflowName</code>.
      </p>
      {customerAuth ? (
        <p>
          Ask your Atlas administrator for the ingest gateway address and an API caller credential.
          Your Console sign-in is separate from API caller access.
        </p>
      ) : (
        <p className="wfd-invoke-endpoint">
          <code>POST {gatewayUrl}</code>
        </p>
      )}
      <p>
        The request waits for the workflow and returns the final capability&apos;s JSON response.
      </p>
      <h3>Request body</h3>
      <dl className="wfd-invoke-fields">
        <div>
          <dt>workflowName</dt>
          <dd>
            string, required · <code>{workflowName}</code>
          </dd>
        </div>
        <div>
          <dt>payload</dt>
          <dd>object, required · must match the active input schema below</dd>
        </div>
        <div>
          <dt>idempotencyKey</dt>
          <dd>string, optional · reuse the same key to avoid duplicate starts</dd>
        </div>
      </dl>
      <h3>Payload</h3>
      <p className="wfd-invoke-hint">
        {sourceExample
          ? 'Development sample from the connected source’s test data, checked against this active workflow. Reusing the same command reuses its business key. Reopen this page for a fresh sample.'
          : 'No tested sample is available for this execution target. Enter real payload values below; field types alone cannot identify valid records in your API.'}
      </p>
      <label>
        Request payload JSON
        <textarea
          aria-label="Request payload JSON"
          rows={10}
          style={{ display: 'block', width: '100%', boxSizing: 'border-box' }}
          value={payloadText}
          onChange={(event) => {
            setEditedPayload(event.target.value);
            setCopied(false);
          }}
        />
      </label>
      {!payload ? <p role="status">{payloadError}</p> : null}
      {inputSchema ? (
        payloadFields.length === 0 ? (
          <p className="wfd-invoke-hint">This workflow accepts an empty payload object.</p>
        ) : (
          <dl className="wfd-invoke-fields">
            {payloadFields.map((field) => (
              <div key={field.path}>
                <dt>
                  <code>{field.path}</code>
                </dt>
                <dd>{field.type}, required</dd>
              </div>
            ))}
          </dl>
        )
      ) : (
        <p className="wfd-invoke-hint">
          Payload fields were not found on the active version. Send a JSON object in{' '}
          <code>payload</code> that matches this workflow&apos;s input schema.
        </p>
      )}
      {payload ? (
        <>
          <p>
            Example <code>POST /ingest</code> body:
          </p>
          <pre className="wfd-invoke-sample">
            <code>{sampleBody}</code>
          </pre>
          {!customerAuth && (
            <>
              <p>
                Sample request for local Compose (<code>{gatewayUrl}</code>
                ):
              </p>
              <pre className="wfd-invoke-sample">
                <code>{sampleCurl}</code>
              </pre>
            </>
          )}
        </>
      ) : null}
      {!customerAuth && (
        <p className="wfd-invoke-hint">
          Compose defaults the caller bearer token to <code>{localIngestCallerToken}</code>.
        </p>
      )}
    </section>
  );
}

export function InvokeUnavailablePanel({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <section aria-label="Invoke via API" className="wfd-invoke-blocked">
      <h2>Invoke via API</h2>
      <p>
        This workflow cannot be invoked until a version is approved and active in{' '}
        {environmentLabels[environmentId]}.
      </p>
    </section>
  );
}
