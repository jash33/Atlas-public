import { describe, expect, it } from 'vite-plus/test';

import { resolveDiagramPreview } from './diagram-preview.js';
import { workflowArtifactYaml, type WorkflowArtifact, type WorkflowReview } from './workflow.js';

const artifact: WorkflowArtifact = {
  workflowVersionId: 'payment-to-billing@2',
  irHash: 'a'.repeat(64),
  executionRequirements: {
    organizationId: 'org_atlas',
    workflowVersionId: 'payment-to-billing@2',
    irHash: 'a'.repeat(64),
    requiredCapabilityVersionIds: [],
  },
  executable: {
    irVersion: 1,
    steps: [
      {
        id: 'load-payment',
        kind: 'capabilityCall',
        capabilityVersionId: 'payment.get@v1',
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
      },
      { id: 'completed', kind: 'terminal', state: 'completed' },
    ],
  },
};

const review: WorkflowReview = {
  workflowVersionId: artifact.workflowVersionId,
  artifact,
  source: null,
  binding: {
    irHash: artifact.irHash,
    policyVersion: 'mvp-validation-v1',
    projectionFingerprint: 'b'.repeat(64),
  },
  migration: null,
  irreversibleBoundary: null,
  steps: [
    {
      stepId: 'load-payment',
      capabilityId: null,
      capabilityVersionId: 'payment.get@v1',
      verified: true,
      provenance: null,
      inputSchema: null,
      outputSchema: null,
      inputMappings: {},
      httpCall: null,
      conditions: null,
      retryPolicy: null,
      timeout: { startToClose: '30 seconds', source: 'runtime-default' },
      idempotency: null,
      secretReference: null,
      compensation: null,
      irreversible: false,
    },
  ],
  graph: {
    nodes: [
      {
        stepId: 'load-payment',
        kind: 'capabilityCall',
        irreversible: false,
        retryPolicy: null,
        terminalState: null,
      },
      {
        stepId: 'completed',
        kind: 'terminal',
        irreversible: false,
        retryPolicy: null,
        terminalState: 'completed',
      },
    ],
    edges: [{ fromStepId: 'load-payment', toStepId: 'completed', kind: 'next' }],
  },
  approval: { enabled: true, diagnostics: [] },
};

describe('diagram YAML preview', () => {
  it('hides the diagram before a validated review exists', () => {
    expect(
      resolveDiagramPreview({ review: undefined, yaml: workflowArtifactYaml(artifact) }),
    ).toEqual({
      status: 'hidden',
    });
  });

  it('uses the server review graph when YAML matches the reviewed artifact', () => {
    const preview = resolveDiagramPreview({ review, yaml: workflowArtifactYaml(artifact) });

    expect(preview.status).toBe('server');
    if (preview.status !== 'server') return;
    expect(preview.graph.nodes.map((node) => node.stepId)).toEqual(['load-payment', 'completed']);
    expect(preview.graph.edges).toEqual([
      { fromStepId: 'load-payment', toStepId: 'completed', kind: 'next', label: 'then' },
    ]);
    expect(preview.graph.nodes[0]).toEqual(
      expect.objectContaining({
        capabilityVersionId: 'payment.get@v1',
        interactive: true,
      }),
    );
  });

  it('marks requested and inferred mappings from the reviewed artifact, including input-sourced bindings', () => {
    const paymentArtifact: WorkflowArtifact = {
      ...artifact,
      executable: {
        irVersion: 1,
        steps: [
          {
            id: 'load-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment.get@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'create-intent',
            kind: 'capabilityCall',
            capabilityVersionId: 'stripe.intent@v1',
            arguments: {
              amount: { source: 'stepOutput', stepId: 'load-payment', path: ['amount'] },
              currency: { source: 'stepOutput', stepId: 'load-payment', path: ['currency'] },
              'Idempotency-Key': { source: 'input', path: ['paymentId'] },
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
      mappingOrigins: [
        { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['currency'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' },
      ],
    };
    const paymentReview: WorkflowReview = {
      ...review,
      artifact: paymentArtifact,
      graph: {
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'create-intent',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'completed',
            kind: 'terminal',
            irreversible: false,
            retryPolicy: null,
            terminalState: 'completed',
          },
        ],
        edges: [
          { fromStepId: 'load-payment', toStepId: 'create-intent', kind: 'next' },
          {
            fromStepId: 'load-payment',
            toStepId: 'create-intent',
            kind: 'mapping',
            label: 'amount',
            origin: 'requested',
          },
          {
            fromStepId: 'load-payment',
            toStepId: 'create-intent',
            kind: 'mapping',
            label: 'currency',
            origin: 'requested',
          },
          { fromStepId: 'create-intent', toStepId: 'completed', kind: 'next' },
        ],
      },
    };

    const preview = resolveDiagramPreview({
      review: paymentReview,
      yaml: workflowArtifactYaml(paymentArtifact),
    });

    expect(preview.status).toBe('server');
    if (preview.status !== 'server') return;
    expect(preview.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mappingField: 'amount',
          origin: 'requested',
          label: 'maps amount · you asked for this',
        }),
        expect.objectContaining({
          mappingField: 'currency',
          origin: 'requested',
          label: 'maps currency · you asked for this',
        }),
        expect.objectContaining({
          mappingField: 'Idempotency-Key',
          origin: 'inferred',
          label: 'maps Idempotency-Key · Atlas inferred this',
        }),
      ]),
    );
  });

  it('renders an unsaved preview from valid YAML whose identity fields are unchanged', () => {
    const preview = resolveDiagramPreview({
      review,
      yaml: workflowArtifactYaml({
        ...artifact,
        executable: {
          irVersion: 1,
          steps: [
            {
              id: 'load-payment',
              kind: 'capabilityCall',
              capabilityVersionId: 'payment.get@v1',
              arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
              retryPolicy: {
                initialInterval: '2s',
                backoffCoefficient: 2,
                maximumInterval: '20s',
                maximumAttempts: 3,
                nonRetryableErrorTypes: ['PaymentNotFound'],
              },
            },
            { id: 'completed', kind: 'terminal', state: 'completed' },
          ],
        },
      }),
    });

    expect(preview).toEqual(
      expect.objectContaining({
        status: 'unsaved-preview',
        banner: 'Unsaved preview - not validated',
      }),
    );
    if (preview.status !== 'unsaved-preview') return;
    expect(preview.graph.nodes[0]?.retryPolicy?.maximumAttempts).toBe(3);
    expect(preview.graph.nodes[0]?.capabilityVersionId).toBe('payment.get@v1');
  });

  it('replaces the graph when YAML is malformed and reports the parse location', () => {
    const preview = resolveDiagramPreview({
      review,
      yaml: 'workflowVersionId: [\n  : broken',
    });

    expect(preview.status).toBe('invalid-yaml');
    if (preview.status !== 'invalid-yaml') return;
    expect(preview.detail).toMatch(/Flow sequence|end with a \]/);
    expect(preview.line).toBe(2);
    expect(preview.column).toBe(11);
    expect('graph' in preview).toBe(false);
  });

  it('replaces the graph when YAML is structurally unrenderable', () => {
    const preview = resolveDiagramPreview({
      review,
      yaml: workflowArtifactYaml({
        ...artifact,
        executable: { irVersion: 1, steps: [] },
      }),
    });

    expect(preview.status).toBe('invalid-yaml');
    if (preview.status !== 'invalid-yaml') return;
    expect(preview.detail).toMatch(/cannot form a workflow graph|executable/i);
    expect('graph' in preview).toBe(false);
  });

  it('does not preview a new artifact when identity fields are mutated', () => {
    const preview = resolveDiagramPreview({
      review,
      yaml: workflowArtifactYaml({ ...artifact, irHash: 'b'.repeat(64) }),
    });

    expect(preview.status).toBe('identity-changed');
    if (preview.status !== 'identity-changed') return;
    expect(preview.detail).toMatch(/identity fields are read-only/i);
    expect('graph' in preview).toBe(false);
  });

  it('replaces the unsaved preview with the backend-validated graph after save', () => {
    const editedYaml = workflowArtifactYaml({
      ...artifact,
      executable: {
        irVersion: 1,
        steps: [
          {
            id: 'load-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment.get@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            retryPolicy: {
              initialInterval: '2s',
              backoffCoefficient: 2,
              maximumInterval: '20s',
              maximumAttempts: 3,
              nonRetryableErrorTypes: [],
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
    });
    expect(resolveDiagramPreview({ review, yaml: editedYaml }).status).toBe('unsaved-preview');

    const savedArtifact = {
      ...artifact,
      workflowVersionId: 'payment-to-billing@2@edit-1',
      irHash: 'c'.repeat(64),
    };
    const savedReview: WorkflowReview = {
      ...review,
      workflowVersionId: savedArtifact.workflowVersionId,
      artifact: savedArtifact,
      graph: {
        ...review.graph,
        nodes: review.graph.nodes.map((node) =>
          node.stepId === 'load-payment'
            ? {
                ...node,
                retryPolicy: {
                  initialInterval: '2s',
                  backoffCoefficient: 2,
                  maximumInterval: '20s',
                  maximumAttempts: 3,
                  nonRetryableErrorTypes: [],
                },
              }
            : node,
        ),
      },
    };

    const preview = resolveDiagramPreview({
      review: savedReview,
      yaml: workflowArtifactYaml(savedArtifact),
    });
    expect(preview.status).toBe('server');
    if (preview.status !== 'server') return;
    expect(preview.graph.nodes[0]?.retryPolicy?.maximumAttempts).toBe(3);
  });
});
