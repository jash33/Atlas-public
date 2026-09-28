import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

import { arazzoUrlBesideOpenApi, parseArazzoDocument } from './arazzo-document.js';
import { plannerRecipeHints } from './capability-architecture.js';

it('keeps catalog operation IDs in planner recipes when the diagram distinguishes services', () => {
  const hints = plannerRecipeHints({
    status: 'ready',
    title: 'Recipes',
    sourceUrl: null,
    notices: [],
    workflows: [],
    nodes: [
      {
        operationId: 'billing:get',
        catalogOperationId: 'get',
        serviceId: 'billing',
        capabilityIdentityId: '1',
        capabilityVersionId: 'one',
      },
      {
        operationId: 'billing:pay',
        catalogOperationId: 'pay',
        serviceId: 'billing',
        capabilityIdentityId: '2',
        capabilityVersionId: 'two',
      },
    ],
    relationships: [
      {
        id: 'edge',
        kind: 'execution-order',
        workflowId: 'billing:pay',
        workflowName: 'Pay',
        sourceOperationId: 'billing:get',
        targetOperationId: 'billing:pay',
        sourceStepId: 'get',
        targetStepId: 'pay',
      },
    ],
  });
  expect(hints?.connections[0]).toMatchObject({
    sourceOperationId: 'get',
    targetOperationId: 'pay',
    sourceServiceId: 'billing',
    targetServiceId: 'billing',
  });
});

const payAtTable = `
arazzo: "1.0.1"
info:
  title: Burgertown workflows
  version: "1.0.0"
sourceDescriptions:
  - name: burgertown
    url: ./openapi.json
    type: openapi
workflows:
  - workflowId: payAtTable
    summary: A. Pay at table
    steps:
      - stepId: reset
        operationId: resetSandbox
        requestBody:
          payload:
            reset: true
      - stepId: getTable
        operationId: getTable
        parameters:
          - name: table_id
            in: path
            value: $inputs.table_id
        outputs:
          checkId: $response.body#/check_id
      - stepId: getCheck
        operationId: getCheck
        parameters:
          - name: check_id
            in: path
            value: $steps.getTable.outputs.checkId
        outputs:
          checkId: $response.body#/id
          dueCents: $response.body#/totals/due_cents
      - stepId: createPayment
        operationId: createPayment
        requestBody:
          payload:
            check_id: $steps.getCheck.outputs.checkId
            amount_cents: $steps.getCheck.outputs.dueCents
        outputs:
          paymentId: $response.body#/id
      - stepId: createCharge
        operationId: createCharge
        requestBody:
          payload:
            payment_id: $steps.createPayment.outputs.paymentId
`;

describe('Arazzo document', () => {
  it('places the Arazzo file next to a Burger Town OpenAPI URL', () => {
    expect(arazzoUrlBesideOpenApi('https://burger-town.test/openapi.json')).toBe(
      'https://burger-town.test/arazzo.yaml',
    );
    expect(arazzoUrlBesideOpenApi('http://host.docker.internal:43123/openapi.json')).toBe(
      'http://host.docker.internal:43123/arazzo.yaml',
    );
  });

  it('reads ordered steps and field hand-offs, skipping sandbox reset', () => {
    const parsed = parseArazzoDocument(payAtTable);

    expect(parsed.title).toBe('Burgertown workflows');
    expect(parsed.workflows).toEqual([{ workflowId: 'payAtTable', summary: 'A. Pay at table' }]);
    expect(
      parsed.relationships.filter((relationship) => relationship.kind === 'execution-order'),
    ).toEqual([
      {
        kind: 'execution-order',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'getTable',
        targetOperationId: 'getCheck',
        sourceStepId: 'getTable',
        targetStepId: 'getCheck',
      },
      {
        kind: 'execution-order',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'getCheck',
        targetOperationId: 'createPayment',
        sourceStepId: 'getCheck',
        targetStepId: 'createPayment',
      },
      {
        kind: 'execution-order',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'createPayment',
        targetOperationId: 'createCharge',
        sourceStepId: 'createPayment',
        targetStepId: 'createCharge',
      },
    ]);
    expect(
      parsed.relationships.filter((relationship) => relationship.kind === 'data-flow'),
    ).toEqual([
      {
        kind: 'data-flow',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'getTable',
        targetOperationId: 'getCheck',
        sourceStepId: 'getTable',
        targetStepId: 'getCheck',
        destinationField: 'check_id',
      },
      {
        kind: 'data-flow',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'getCheck',
        targetOperationId: 'createPayment',
        sourceStepId: 'getCheck',
        targetStepId: 'createPayment',
        destinationField: 'check_id',
      },
      {
        kind: 'data-flow',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'getCheck',
        targetOperationId: 'createPayment',
        sourceStepId: 'getCheck',
        targetStepId: 'createPayment',
        destinationField: 'amount_cents',
      },
      {
        kind: 'data-flow',
        workflowId: 'payAtTable',
        workflowName: 'A. Pay at table',
        sourceOperationId: 'createPayment',
        targetOperationId: 'createCharge',
        sourceStepId: 'createPayment',
        targetStepId: 'createCharge',
        destinationField: 'payment_id',
      },
    ]);
  });

  it('does not treat a repeated operation as a self-loop', () => {
    const parsed = parseArazzoDocument(`
arazzo: "1.0.1"
info:
  title: Repeat
workflows:
  - workflowId: bumpTicket
    summary: Fire then done
    steps:
      - stepId: fire
        operationId: completeTicket
      - stepId: done
        operationId: completeTicket
`);
    expect(parsed.relationships).toEqual([]);
  });

  it('rejects documents that are not Arazzo 1.0 recipes', () => {
    expect(() => parseArazzoDocument('[]')).toThrow('Arazzo document');
    expect(() => parseArazzoDocument('arazzo: "1.1.0"\ninfo:\n  title: Next\n')).toThrow(
      'Arazzo 1.0',
    );
    expect(() => parseArazzoDocument('arazzo: "1.0.1"\ninfo:\n  title: Empty\n')).toThrow(
      'workflow',
    );
  });

  it('reads every Burgertown recipe from the checked-in Arazzo file', () => {
    const parsed = parseArazzoDocument(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/arazzo-burgertown.yaml'),
        'utf8',
      ),
    );
    expect(parsed.workflows.map((workflow) => workflow.workflowId)).toEqual([
      'payAtTable',
      'refundThenVoid',
      'orderThenKitchen',
      'localDiscountThenPay',
      'deliveryEndToEnd',
      'buildABurger',
      'rewardsRedeemThenPay',
      'deliveryFailedThenRefund',
      'guestDietaryFilter',
    ]);
    expect(
      parsed.relationships.some(
        (relationship) =>
          relationship.kind === 'data-flow' &&
          relationship.sourceOperationId === 'createCheck' &&
          relationship.targetOperationId === 'addItem' &&
          relationship.destinationField === 'check_id',
      ),
    ).toBe(true);
    expect(
      parsed.relationships.every(
        (relationship) => relationship.sourceOperationId !== 'resetSandbox',
      ),
    ).toBe(true);
  });
});
