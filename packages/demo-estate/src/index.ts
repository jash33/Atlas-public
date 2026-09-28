export interface DemoCapabilityAnnotation {
  capability:
    | { operationId: string }
    | { channelAddress: string; messageKey: string; operationId: string };
  owner: string;
  secretAlias: string | null;
  businessSemantics: Record<string, unknown>;
  idempotencyField: string | null;
  compensatedBy: { operationId: string } | null;
  irreversibleAfter: boolean;
}

export const demoProfileIds = ['sample', 'burger-town'] as const;
export type DemoProfileId = (typeof demoProfileIds)[number];

export interface DemoProfileDefinition {
  organizationName: string;
  displayUser: { name: string; email: string };
  users: Record<'author' | 'admin' | 'operator', { name: string; email: string }>;
}

export const demoProfiles: Record<DemoProfileId, DemoProfileDefinition> = {
  sample: {
    organizationName: 'Atlas Demo',
    displayUser: { email: 'user@atlas.demo', name: 'User Profile' },
    users: {
      author: { email: 'author@atlas.local', name: 'Atlas Author' },
      operator: { email: 'operator@atlas.local', name: 'Atlas Operator' },
      admin: { email: 'admin@atlas.local', name: 'Atlas Admin' },
    },
  },
  'burger-town': {
    organizationName: 'Burger Town',
    displayUser: { email: 'demo@burgertown.local', name: 'Burger Town Demo' },
    users: {
      author: { email: 'demo@burgertown.local', name: 'Burger Town Demo' },
      operator: { email: 'operator@burgertown.local', name: 'Burger Town Operator' },
      admin: { email: 'admin@burgertown.local', name: 'Burger Town Admin' },
    },
  },
};

export interface DemoSourceConnectionMetadata {
  sourceType: 'internal' | 'third-party';
  provider: string;
  defaultConnectionMode: 'local' | 'contract-faithful-rehearsal';
  upstreamRepository: string | null;
  upstreamRevision: string | null;
  upstreamPath: string | null;
  officialSandboxUrl: string | null;
  officialSandboxMode: string | null;
}

export interface DemoCapabilitySource extends DemoSourceConnectionMetadata {
  key: string;
  label: string;
  serviceId: string;
  format: 'openapi' | 'asyncapi';
  specFile: string;
  annotations: DemoCapabilityAnnotation[];
}

export type ThirdPartyDemoMode = 'contract-faithful-rehearsal' | 'official-test';

export const workflowSandboxTestKinds = [
  'happy-path',
  'contract-mapping',
  'authentication',
  'retry',
  'rate-limit',
  'timeout',
  'duplicate-event',
  'partial-failure',
  'compatibility',
] as const;
export type WorkflowSandboxTestKind = (typeof workflowSandboxTestKinds)[number];

export interface WorkflowSandboxProgressWire {
  phase: 'preparing' | 'running' | 'finalizing';
  completed: number;
  total: number;
  currentTest?: { kind: WorkflowSandboxTestKind; stepId: string | null };
}

export const workflowSandboxProviderModes = [
  'local',
  'contract-faithful-rehearsal',
  'official-test',
] as const;
export type WorkflowSandboxProviderMode = (typeof workflowSandboxProviderModes)[number];

export const workflowSandboxExecutionMethods = [
  'static-validation',
  'local-test-service',
  'remote-sandbox',
] as const;
export type WorkflowSandboxExecutionMethod = (typeof workflowSandboxExecutionMethods)[number];

// Bump these identities whenever a deployment changes sandbox execution semantics.
export const workflowSandboxWorkerVersion = 'atlas-worker-v3';
export const workflowSandboxRuntimeVersion = 'temporal-adapter-v3';

export interface WorkflowSandboxProviderContractWire {
  capabilityVersionId: string;
  serviceId: string;
  operationId: string;
  documentHash: string;
  provider: string;
  mode: WorkflowSandboxProviderMode;
  method: string | null;
  path: string | null;
  requestSchema: unknown;
  responseSchema: unknown;
  idempotencyField?: string | null | undefined;
}

export interface WorkflowSandboxTestWire {
  testId: string;
  kind: WorkflowSandboxTestKind;
  stepId: string | null;
  capabilityVersionId: string | null;
  expectation: string;
  requestSample: Record<string, unknown> | null;
  expectedResponseSchema: unknown;
  failureErrorType?: string | undefined;
}

export interface WorkflowSandboxSuiteWire {
  organizationId: string;
  environmentId: string;
  workflowVersionId: string;
  irHash: string;
  workflow: unknown;
  providerContracts: WorkflowSandboxProviderContractWire[];
  tests: WorkflowSandboxTestWire[];
  targetBindings: WorkflowSandboxTargetBindingWire[];
}

export interface WorkflowSandboxTargetSelectionWire {
  capabilityVersionId: string;
  targetKey: string;
  targetRevision: number;
  testDataProfileKey: string;
  testDataVersion: number;
}

export interface WorkflowSandboxTargetBindingWire extends WorkflowSandboxTargetSelectionWire {
  baseUrl: string;
  hostname: string;
  healthPath: string;
  controlPaths: {
    resources: string;
    faults: string;
    observations: string;
  };
  secretAlias: string | null;
  inputs: Record<string, unknown>;
  targetState: {
    mode: 'replace' | 'merge';
    resources: Array<{
      service: string;
      collection: string;
      id: string;
      document: unknown;
    }>;
  };
  setupAssumptions: Array<{
    path: Array<string | number>;
    equals: unknown;
  }>;
}

export type WorkflowSandboxTargetEvidenceWire = WorkflowSandboxTargetSelectionWire;

export function workflowSandboxTargetEvidence(
  selection: WorkflowSandboxTargetSelectionWire,
): WorkflowSandboxTargetEvidenceWire {
  return {
    capabilityVersionId: selection.capabilityVersionId,
    targetKey: selection.targetKey,
    targetRevision: selection.targetRevision,
    testDataProfileKey: selection.testDataProfileKey,
    testDataVersion: selection.testDataVersion,
  };
}

export interface WorkflowSandboxOutcomeWire {
  testId: string;
  status: 'passed' | 'failed';
  workerVersion: string;
  runtimeVersion: string;
  executionMethods: WorkflowSandboxExecutionMethod[];
  detail?: string;
  temporalWorkflowId?: string;
  temporalRunId?: string;
  terminalOutcome?: 'completed' | 'validation_failed' | 'manual_review' | 'repair_required';
  attempts?: Array<{ stepId: string; attempt: number; status: number }>;
  temporalHistory?: {
    scheduledActivities: number;
    completedActivities: number;
    failedActivities: number;
    timedOutActivities: number;
  };
  providerObservations?: {
    sideEffectCount: number;
    invoiceStates: Array<{ status: string; version: number }>;
    billingMutations: Array<{ operationId: string; outcome: string; replayed: boolean }>;
    compensationOrder: string[];
  };
  targetEvidence?: WorkflowSandboxTargetEvidenceWire[];
}

export function demoExecutionHostname(
  source: DemoCapabilitySource,
  providerMode: ThirdPartyDemoMode,
) {
  if (source.sourceType !== 'third-party' || providerMode !== 'official-test') {
    return 'mock-services';
  }
  if (!source.officialSandboxUrl) {
    throw new Error(`${source.provider} official-test mode requires an official sandbox URL`);
  }
  return new URL(source.officialSandboxUrl).hostname;
}

export const demoEstateRevision = 'local-demo-v6';

export const demoCapabilitySources: DemoCapabilitySource[] = [
  {
    key: 'payments',
    label: 'Internal Payment API (OpenAPI 3.1)',
    serviceId: 'payments',
    format: 'openapi',
    specFile: 'payment.openapi.json',
    sourceType: 'internal',
    provider: 'Atlas internal',
    defaultConnectionMode: 'local',
    upstreamRepository: null,
    upstreamRevision: null,
    upstreamPath: null,
    officialSandboxUrl: null,
    officialSandboxMode: null,
    annotations: [
      {
        capability: { operationId: 'getPayment' },
        owner: 'payments-team',
        secretAlias: null,
        businessSemantics: {
          sourceType: 'internal',
          provider: 'Atlas internal',
          readsAuthoritativePayment: true,
        },
        idempotencyField: null,
        compensatedBy: null,
        irreversibleAfter: false,
      },
    ],
  },
  {
    key: 'billing',
    label: 'Billing API (OpenAPI 3.1)',
    serviceId: 'billing',
    format: 'openapi',
    specFile: 'billing.openapi.json',
    sourceType: 'internal',
    provider: 'Atlas internal',
    defaultConnectionMode: 'local',
    upstreamRepository: null,
    upstreamRevision: null,
    upstreamPath: null,
    officialSandboxUrl: null,
    officialSandboxMode: null,
    annotations: [
      {
        capability: { operationId: 'getInvoice' },
        owner: 'billing-team',
        secretAlias: null,
        businessSemantics: { readsAuthoritativeInvoice: true },
        idempotencyField: null,
        compensatedBy: null,
        irreversibleAfter: false,
      },
      {
        capability: { operationId: 'beginInvoiceSettlement' },
        owner: 'billing-team',
        secretAlias: null,
        businessSemantics: { startsSettlement: true },
        idempotencyField: 'idempotencyKey',
        compensatedBy: { operationId: 'cancelInvoiceSettlement' },
        irreversibleAfter: false,
      },
      {
        capability: { operationId: 'cancelInvoiceSettlement' },
        owner: 'billing-team',
        secretAlias: null,
        businessSemantics: { compensatesSettlement: true },
        idempotencyField: 'idempotencyKey',
        compensatedBy: null,
        irreversibleAfter: true,
      },
      {
        capability: { operationId: 'markInvoicePaid' },
        owner: 'billing-team',
        secretAlias: null,
        businessSemantics: { marksInvoicePaid: true },
        idempotencyField: 'idempotencyKey',
        compensatedBy: null,
        irreversibleAfter: true,
      },
    ],
  },
  {
    key: 'operations',
    label: 'Operations API (OpenAPI 3.1)',
    serviceId: 'operations',
    format: 'openapi',
    specFile: 'operations.openapi.json',
    sourceType: 'internal',
    provider: 'Atlas internal',
    defaultConnectionMode: 'local',
    upstreamRepository: null,
    upstreamRevision: null,
    upstreamPath: null,
    officialSandboxUrl: null,
    officialSandboxMode: null,
    annotations: [
      {
        capability: { operationId: 'notifyPaymentOperations' },
        owner: 'operations-team',
        secretAlias: null,
        businessSemantics: { notifiesHumans: true },
        idempotencyField: 'idempotencyKey',
        compensatedBy: null,
        irreversibleAfter: true,
      },
    ],
  },
  {
    key: 'events',
    label: 'Invoice events (AsyncAPI 3.0)',
    serviceId: 'events',
    format: 'asyncapi',
    specFile: 'events.asyncapi.json',
    sourceType: 'internal',
    provider: 'Atlas internal',
    defaultConnectionMode: 'local',
    upstreamRepository: null,
    upstreamRevision: null,
    upstreamPath: null,
    officialSandboxUrl: null,
    officialSandboxMode: null,
    annotations: [
      {
        capability: {
          channelAddress: 'invoice.paid',
          messageKey: 'invoicePaid',
          operationId: 'publishInvoicePaid',
        },
        owner: 'billing-team',
        secretAlias: null,
        businessSemantics: { announcesInvoicePaid: true },
        idempotencyField: 'eventId',
        compensatedBy: null,
        irreversibleAfter: true,
      },
    ],
  },
  {
    key: 'stripe',
    label: 'Stripe API (test mode or rehearsal fallback)',
    serviceId: 'stripe',
    format: 'openapi',
    specFile: 'stripe.openapi.json',
    sourceType: 'third-party',
    provider: 'Stripe',
    defaultConnectionMode: 'contract-faithful-rehearsal',
    upstreamRepository: 'https://github.com/stripe/openapi',
    upstreamRevision: '24e4796f5aa12204d7e208ef447a5d11705b9b41',
    upstreamPath: 'latest/openapi.spec3.json',
    officialSandboxUrl: 'https://api.stripe.com',
    officialSandboxMode: 'Stripe test mode via a STRIPE_SECRET_KEY secret reference',
    annotations: [
      {
        capability: { operationId: 'PostPaymentIntents' },
        owner: 'payments-platform',
        secretAlias: 'STRIPE_SECRET_KEY',
        businessSemantics: {
          sourceType: 'third-party',
          provider: 'Stripe',
          defaultConnectionMode: 'contract-faithful-rehearsal',
          supportsOfficialTestMode: true,
          upstreamContractRepository: 'https://github.com/stripe/openapi',
          upstreamContractRevision: '24e4796f5aa12204d7e208ef447a5d11705b9b41',
          upstreamContractPath: 'latest/openapi.spec3.json',
          createsPaymentIntent: true,
        },
        idempotencyField: 'Idempotency-Key',
        compensatedBy: null,
        irreversibleAfter: true,
      },
    ],
  },
  {
    key: 'slack',
    label: 'Slack API (test workspace or rehearsal fallback)',
    serviceId: 'slack',
    format: 'openapi',
    specFile: 'slack.openapi.json',
    sourceType: 'third-party',
    provider: 'Slack',
    defaultConnectionMode: 'contract-faithful-rehearsal',
    upstreamRepository: 'https://github.com/slackapi/slack-api-specs',
    upstreamRevision: 'bc08db49625630e3585bf2f1322128ea04f2a7f3',
    upstreamPath: 'web-api/slack_web_openapi_v2.json',
    officialSandboxUrl: 'https://slack.com/api',
    officialSandboxMode: 'Slack test workspace via a SLACK_BOT_TOKEN secret reference',
    annotations: [
      {
        capability: { operationId: 'chat_postMessage' },
        owner: 'business-operations',
        secretAlias: 'SLACK_BOT_TOKEN',
        businessSemantics: {
          sourceType: 'third-party',
          provider: 'Slack',
          defaultConnectionMode: 'contract-faithful-rehearsal',
          supportsOfficialTestMode: true,
          upstreamContractRepository: 'https://github.com/slackapi/slack-api-specs',
          upstreamContractRevision: 'bc08db49625630e3585bf2f1322128ea04f2a7f3',
          upstreamContractPath: 'web-api/slack_web_openapi_v2.json',
          sendsBusinessNotification: true,
        },
        idempotencyField: 'client_msg_id',
        compensatedBy: null,
        irreversibleAfter: true,
      },
    ],
  },
  {
    key: 'hubspot',
    label: 'HubSpot CRM (developer test account or rehearsal fallback)',
    serviceId: 'hubspot',
    format: 'openapi',
    specFile: 'hubspot.openapi.json',
    sourceType: 'third-party',
    provider: 'HubSpot',
    defaultConnectionMode: 'contract-faithful-rehearsal',
    upstreamRepository: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
    upstreamRevision: 'ab9ffa9c6f456fd8fce017f3d36fe619cbe88315',
    upstreamPath: 'PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json',
    officialSandboxUrl: 'https://api.hubapi.com',
    officialSandboxMode:
      'HubSpot developer test account via a HUBSPOT_ACCESS_TOKEN secret reference',
    annotations: [
      {
        capability: { operationId: 'createContact' },
        owner: 'revenue-operations',
        secretAlias: 'HUBSPOT_ACCESS_TOKEN',
        businessSemantics: {
          sourceType: 'third-party',
          provider: 'HubSpot',
          defaultConnectionMode: 'contract-faithful-rehearsal',
          supportsOfficialTestMode: true,
          upstreamContractRepository:
            'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
          upstreamContractRevision: 'ab9ffa9c6f456fd8fce017f3d36fe619cbe88315',
          upstreamContractPath: 'PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json',
          upstreamOperationId: 'post-/crm/v3/objects/contacts_create',
          createsCrmContact: true,
        },
        idempotencyField: 'email',
        compensatedBy: null,
        irreversibleAfter: true,
      },
    ],
  },
];
