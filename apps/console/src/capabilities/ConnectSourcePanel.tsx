import { useEffect, useState } from 'react';

import type { DemoProfileId, EnvironmentId } from '../shell/session.js';
import {
  connectBurgerTown,
  runSourceDiscovery,
  type BurgerTownConnectionResult,
  type DiscoveryResult,
  type DiscoverySubmission,
  useBurgerTownConnectionDefaults,
} from './data.js';
import { FailedReingestOutcome } from './reingest.js';
import { capabilityArchitectureHash } from './CapabilityArchitecture.js';
import { RepositoryContracts } from './RepositoryContracts.js';

type SubmitState<T extends DiscoveryResult = DiscoveryResult> =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'succeeded'; result: T; serviceId?: string }
  | { phase: 'failed'; message: string };

export interface FormState {
  serviceId: string;
  documentJson: string;
}

const emptyForm: FormState = { serviceId: '', documentJson: '' };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function openApiTitle(document: Record<string, unknown>): string {
  const info = asRecord(document.info);
  return typeof info?.title === 'string' ? info.title.trim() : '';
}

function serviceIdFromDocument(document: Record<string, unknown>): string {
  return openApiTitle(document)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseJsonInput(label: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseOpenApiDocument(raw: string): Record<string, unknown> {
  const parsed = parseJsonInput('OpenAPI document', raw);
  const document = asRecord(parsed);
  if (!document) throw new Error('OpenAPI document must be a JSON object');
  if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.')) {
    throw new Error('Document must be an OpenAPI 3 specification');
  }
  return document;
}

export function buildSubmission(organizationId: string, form: FormState): DiscoverySubmission {
  const document = parseOpenApiDocument(form.documentJson);
  const serviceId = form.serviceId.trim() || serviceIdFromDocument(document);
  if (!serviceId) throw new Error('Service id is required');
  const label = openApiTitle(document) || serviceId;
  return {
    organizationId,
    serviceId,
    source: {
      format: 'openapi',
      document,
      evidence: { kind: 'human-confirmed', label },
    },
    manifest: {
      source: { kind: 'human-confirmed', label: `${label} import` },
      annotations: [],
    },
  };
}

function applyDocumentJson(current: FormState, documentJson: string): FormState {
  const next = { ...current, documentJson };
  if (current.serviceId.trim()) return next;
  try {
    const derived = serviceIdFromDocument(parseOpenApiDocument(documentJson));
    if (derived) next.serviceId = derived;
  } catch {
    return next;
  }
  return next;
}

interface ConnectSourcePanelProps {
  organizationId: string;
  environmentId: EnvironmentId;
  bearerToken: string;
  demoProfile: DemoProfileId;
  initialServiceId: string | null;
  onDiscovered: (result: DiscoveryResult) => void;
  onClose: () => void;
}

function BurgerTownConnectPanel({
  organizationId,
  environmentId,
  bearerToken,
  onDiscovered,
  onClose,
  onImportOpenApi,
}: Pick<
  ConnectSourcePanelProps,
  'organizationId' | 'environmentId' | 'bearerToken' | 'onDiscovered' | 'onClose'
> & { onImportOpenApi: () => void }) {
  const [applicationUrl, setApplicationUrl] = useState('');
  const [openApiUrl, setOpenApiUrl] = useState('');
  const [arazzoUrl, setArazzoUrl] = useState('');
  const [state, setState] = useState<SubmitState<BurgerTownConnectionResult>>({ phase: 'idle' });
  const { remote: defaults } = useBurgerTownConnectionDefaults(
    organizationId,
    environmentId,
    bearerToken,
  );

  useEffect(() => {
    if (defaults.status !== 'ready') return;
    setApplicationUrl((current) => current || defaults.data.applicationUrl);
    setOpenApiUrl((current) => current || defaults.data.openApiUrl);
    setArazzoUrl((current) => current || defaults.data.arazzoUrl || '');
  }, [defaults]);

  const submit = async () => {
    setState({ phase: 'running' });
    try {
      const result = await connectBurgerTown(
        {
          organizationId,
          environmentId,
          applicationUrl,
          openApiUrl,
          ...(arazzoUrl ? { arazzoUrl } : {}),
        },
        bearerToken,
      );
      setState({ phase: 'succeeded', result });
      onDiscovered(result);
    } catch (error) {
      setState({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Burger Town connection failed',
      });
    }
  };

  return (
    <section aria-label="Connect Burger Town" className="cat-connect">
      <header className="cat-connect-heading">
        <div>
          <p className="cat-kicker">Prepared demo source</p>
          <h2>Connect Burger Town</h2>
          <p className="cat-connect-note">
            Review the prepared addresses. Atlas checks them, adds every OpenAPI operation, and
            reads Arazzo recipes when that file is present. Polling stays stopped. Workflows are
            created separately in Atlas.
          </p>
          <button className="cat-secondary" onClick={onImportOpenApi} type="button">
            Import your own OpenAPI spec instead
          </button>
        </div>
        <button className="cat-secondary" onClick={onClose} type="button">
          ← Back to catalog
        </button>
      </header>
      <form
        className="cat-connect-form cat-connect-form-simple"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="cat-field cat-field-wide">
          <span>Burger Town application address</span>
          <input
            onChange={(event) => setApplicationUrl(event.target.value)}
            placeholder="https://burger-town.example"
            required
            type="url"
            value={applicationUrl}
          />
        </label>
        <label className="cat-field cat-field-wide">
          <span>Burger Town OpenAPI address</span>
          <input
            onChange={(event) => setOpenApiUrl(event.target.value)}
            placeholder="https://burger-town.example/openapi.json"
            required
            type="url"
            value={openApiUrl}
          />
        </label>
        <label className="cat-field cat-field-wide">
          <span>Burger Town Arazzo address</span>
          <input
            onChange={(event) => setArazzoUrl(event.target.value)}
            placeholder="https://burger-town.example/arazzo.yaml"
            type="url"
            value={arazzoUrl}
          />
        </label>
        {defaults.status === 'loading' && (
          <p className="cat-connect-note" role="status">
            Loading the prepared addresses...
          </p>
        )}
        {defaults.status === 'error' && (
          <p className="cat-submit-result cat-submit-bad" role="alert">
            {defaults.message}
          </p>
        )}
        <div className="cat-connect-actions">
          <button className="cat-primary" disabled={state.phase === 'running'} type="submit">
            {state.phase === 'running' ? 'Connecting Burger Town…' : 'Connect Burger Town'}
          </button>
          {state.phase === 'succeeded' && (
            <p className="cat-submit-result cat-submit-good" role="status">
              Burger Town is connected. {state.result.capabilities.length} capabilities were added;
              polling is {state.result.monitoringState}
              {typeof state.result.arazzoWorkflowCount === 'number'
                ? `; ${state.result.arazzoWorkflowCount} Arazzo ${state.result.arazzoWorkflowCount === 1 ? 'recipe' : 'recipes'} stored`
                : ''}
              . <a href={capabilityArchitectureHash(environmentId, 'all')}>View architecture</a>
            </p>
          )}
          {state.phase === 'failed' && (
            <p className="cat-submit-result cat-submit-bad" role="alert">
              {state.message}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

function OpenApiConnectPanel({
  organizationId,
  environmentId,
  bearerToken,
  initialServiceId,
  onDiscovered,
  onClose,
  onConnectDemo,
}: Omit<ConnectSourcePanelProps, 'demoProfile'> & { onConnectDemo: () => void }) {
  const [form, setForm] = useState<FormState>(() => ({
    ...emptyForm,
    serviceId: initialServiceId ?? '',
  }));
  const [fileName, setFileName] = useState('');
  const [state, setState] = useState<SubmitState>({ phase: 'idle' });
  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const readSpecificationFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const documentJson = typeof reader.result === 'string' ? reader.result : '';
      setFileName(file.name);
      setForm((current) => applyDocumentJson(current, documentJson));
      setState({ phase: 'idle' });
    };
    reader.onerror = () => setState({ phase: 'failed', message: `Could not read ${file.name}` });
    reader.readAsText(file);
  };

  const submit = async () => {
    setState({ phase: 'running' });
    try {
      const submission = buildSubmission(organizationId, form);
      const result = await runSourceDiscovery(submission, environmentId, bearerToken);
      setState({ phase: 'succeeded', result, serviceId: submission.serviceId });
      onDiscovered(result);
    } catch (error) {
      setState({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Import failed',
      });
    }
  };

  return (
    <section aria-label="Import OpenAPI spec" className="cat-connect">
      <header className="cat-connect-heading">
        <div>
          <p className="cat-kicker">Import</p>
          <h2>Import an OpenAPI spec</h2>
          <p className="cat-connect-note">
            Paste or choose an OpenAPI 3 JSON file. Atlas lists each operation as a capability.
          </p>
          <p className="cat-connect-note">
            Just testing? Use the pre-filled Burger Town connection.
          </p>
          <button className="cat-secondary" onClick={onConnectDemo} type="button">
            Use Burger Town demo
          </button>
        </div>
        <button className="cat-secondary" onClick={onClose} type="button">
          ← Back to catalog
        </button>
      </header>
      <form
        className="cat-connect-form cat-connect-form-simple"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="cat-field">
          <span>Service id</span>
          <input
            onChange={(event) => update({ serviceId: event.target.value })}
            placeholder="Filled from the spec title if left blank"
            value={form.serviceId}
          />
        </label>
        <label className="cat-field cat-field-wide">
          <span>OpenAPI JSON file</span>
          <input
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) readSpecificationFile(file);
            }}
            type="file"
          />
          {fileName ? <small>Loaded {fileName}</small> : null}
        </label>
        <label className="cat-field cat-field-wide">
          <span>OpenAPI JSON</span>
          <textarea
            onChange={(event) => {
              const documentJson = event.target.value;
              setFileName('');
              setForm((current) => applyDocumentJson(current, documentJson));
            }}
            placeholder='{"openapi":"3.1.0","info":{"title":"…"},"paths":{}}'
            required
            rows={16}
            spellCheck={false}
            value={form.documentJson}
          />
        </label>
        <div className="cat-connect-actions">
          <button className="cat-primary" disabled={state.phase === 'running'} type="submit">
            {state.phase === 'running' ? 'Importing…' : 'Import spec'}
          </button>
          {state.phase === 'succeeded' && state.serviceId && (
            <FailedReingestOutcome
              environmentId={environmentId}
              result={state.result}
              serviceId={state.serviceId}
            />
          )}
          {state.phase === 'failed' && (
            <p className="cat-submit-result cat-submit-bad" role="alert">
              {state.message}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

export function ConnectSourcePanel(props: ConnectSourcePanelProps) {
  const [source, setSource] = useState('github');
  return source === 'github' ? (
    <>
      <RepositoryContracts
        organizationId={props.organizationId}
        environmentId={props.environmentId}
        bearerToken={props.bearerToken}
        canManage
        showConnect
        onClose={props.onClose}
      />
      <div className="repository-actions">
        <button className="cat-secondary" type="button" onClick={() => setSource('openapi')}>
          Import an OpenAPI document
        </button>
        {props.demoProfile === 'burger-town' && (
          <button className="cat-secondary" type="button" onClick={() => setSource('burger-town')}>
            Connect the running Burger Town demo
          </button>
        )}
      </div>
    </>
  ) : source === 'burger-town' ? (
    <BurgerTownConnectPanel {...props} onImportOpenApi={() => setSource('openapi')} />
  ) : (
    <OpenApiConnectPanel {...props} onConnectDemo={() => setSource('burger-town')} />
  );
}
