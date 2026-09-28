import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { CheckFailurePanel, CheckRunError } from './CheckFailurePanel.js';
import { ClarificationPanel } from './ClarificationPanel.js';
import { DraftProgress } from './DraftProgress.js';
import { WorkflowCompose } from './WorkflowCompose.js';
import {
  createDraftingState,
  environmentActionForAnswer,
  receiveDraftResponse,
  submitDraft,
} from './drafting-state.js';
import { createRequestEditor, type RequestEditor } from './request-editor.js';

const switchAnswer = 'Switch to production and review this request';

describe('Create Workflow conversation', () => {
  it('shows a compose error while a clarification question remains on the conversation', () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkflowCompose,
        {
          canDraft: true,
          editor: createRequestEditor({ text: 'Settle a payment', cursor: 16 }),
          error: 'Workflow drafting failed',
          onDraft: vi.fn<() => void>(),
          onEditorChange: vi.fn<(editor: RequestEditor) => void>(),
          onNameChange: vi.fn<(name: string) => void>(),
          showDraft: false,
          workflowName: 'Settle payments',
        },
        createElement(ClarificationPanel, {
          answer: '',
          canDraft: true,
          disabled: false,
          onAnswerChange: () => undefined,
          onSubmitAnswer: () => undefined,
          question: 'Which payment should Atlas read with getPayment?',
          suggestedAnswers: ['The current payment'],
        }),
      ),
    );

    expect(html).toContain('Which payment should Atlas read with getPayment?');
    expect(html).toContain('The current payment');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Workflow drafting failed');
    expect(html).not.toContain('wf-compose-split');
    expect(html).not.toContain('wf-d3-graph');
  });

  it('changes environment and restarts compose when the production suggested answer is chosen', () => {
    const drafting = receiveDraftResponse(
      submitDraft(
        createDraftingState('Notify operations after getPayment'),
        'Notify operations after getPayment',
      ),
      1,
      {
        status: 'clarification_required',
        reason: 'mapping-impossible',
        question:
          'Some requested operations or field mappings are not available in development. How should Atlas adapt the workflow?',
        suggestedAnswers: [
          switchAnswer,
          'Keep the valid parts and omit unavailable operations',
          'Simplify to the smallest valid workflow that satisfies the core request',
        ],
        suggestedAnswerActions: [
          {
            answer: switchAnswer,
            action: 'change-environment',
            environmentId: 'production',
          },
        ],
        continuation: 'cont.token',
      },
    );
    const html = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: true,
        disabled: false,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: drafting.question ?? '',
        suggestedAnswers: drafting.suggestedAnswers ?? [],
      }),
    );

    expect(html).toContain(switchAnswer);
    expect(html).toContain('type="button"');
    expect(environmentActionForAnswer(drafting, switchAnswer)).toEqual({
      answer: switchAnswer,
      action: 'change-environment',
      environmentId: 'production',
    });
  });

  it('keeps a clarification in chat without running checks or showing a graph', () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkflowCompose,
        {
          canDraft: true,
          editor: createRequestEditor({ text: 'Settle a payment', cursor: 16 }),
          onDraft: vi.fn<() => void>(),
          onEditorChange: vi.fn<(editor: RequestEditor) => void>(),
          onNameChange: vi.fn<(name: string) => void>(),
          showDraft: false,
          workflowName: 'Settle payments',
        },
        createElement(ClarificationPanel, {
          answer: '',
          canDraft: true,
          disabled: false,
          onAnswerChange: () => undefined,
          onSubmitAnswer: () => undefined,
          question: 'Which payment should Atlas read with getPayment?',
          suggestedAnswers: ['The current payment'],
        }),
      ),
    );

    expect(html).toContain('Which payment should Atlas read with getPayment?');
    expect(html).not.toContain('Running checks');
    expect(html).not.toContain('Checks found a problem');
    expect(html).not.toContain('Run checks');
    expect(html).not.toContain('wf-d3-graph');
    expect(html).not.toContain('wf-compose-split');
  });

  it('explains a check failure in chat above the marked graph step', () => {
    const running = renderToStaticMarkup(
      createElement(
        WorkflowCompose,
        {
          canDraft: true,
          editor: createRequestEditor({ text: 'Create a Stripe payment intent', cursor: 32 }),
          graph: createElement(
            'section',
            { 'aria-label': 'Workflow draft graph', className: 'wf-graph' },
            createElement('svg', { className: 'wf-d3-graph' }, 'Create stripe payment intent'),
          ),
          onDraft: vi.fn<() => void>(),
          onEditorChange: vi.fn<(editor: RequestEditor) => void>(),
          onNameChange: vi.fn<(name: string) => void>(),
          showDraft: false,
          workflowName: 'Settle payments',
        },
        createElement(DraftProgress, {
          progress: {
            requestId: 'finished',
            status: 'completed',
            liveText: false,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          },
          onCancel: vi.fn<() => void>(),
        }),
      ),
    );
    const failed = renderToStaticMarkup(
      createElement(
        WorkflowCompose,
        {
          canDraft: true,
          editor: createRequestEditor({ text: 'Create a Stripe payment intent', cursor: 32 }),
          graph: createElement(
            'section',
            { 'aria-label': 'Workflow draft graph', className: 'wf-graph' },
            createElement(
              'div',
              { className: 'wf-graph-node wf-graph-node-failed' },
              createElement('strong', null, 'Create stripe payment intent'),
              createElement(
                'p',
                { className: 'wf-graph-node-failure' },
                'stripe · PostPaymentIntents expects an idempotency key and none was provided.',
              ),
            ),
          ),
          onDraft: vi.fn<() => void>(),
          onEditorChange: vi.fn<(editor: RequestEditor) => void>(),
          onNameChange: vi.fn<(name: string) => void>(),
          showDraft: false,
          workflowName: 'Settle payments',
        },
        createElement(CheckFailurePanel, {
          canDraft: true,
          explanation: {
            error: 'stripe · PostPaymentIntents expects an idempotency key.',
            why: 'The draft did not provide one.',
            suggestedFix: 'Map the idempotency key from paymentId.',
            stepId: 'create-stripe-intent',
            graphMark:
              'stripe · PostPaymentIntents expects an idempotency key and none was provided.',
          },
          onAcceptFix: vi.fn<(fix: string) => void>(),
        }),
      ),
    );

    expect(running).toContain('aria-busy="false"');
    expect(running).not.toContain('Running checks');
    expect(running).not.toContain('Understanding your request');
    expect(running).toContain('wf-compose-split');
    expect(running).toContain('wf-d3-graph');
    expect(running).not.toContain('Running checks…');
    expect(running).not.toContain('Run checks');
    expect(failed).toContain('Checks found a problem');
    expect(failed).toContain('stripe · PostPaymentIntents expects an idempotency key.');
    expect(failed).toContain('The draft did not provide one.');
    expect(failed).toContain('Map the idempotency key from paymentId.');
    expect(failed).toContain('wf-graph-node-failed');
    expect(failed).toContain(
      'stripe · PostPaymentIntents expects an idempotency key and none was provided.',
    );
    expect(failed).toContain('type="button"');
    expect(failed).not.toContain('tabindex="-1"');
    expect(failed).not.toContain('Run checks');
    expect(failed).not.toContain('irHash');
    expect(failed).not.toContain('fingerprint');
    expect(failed).not.toContain('SANDBOX_TESTS');
  });

  it('explains a check runner outage in chat instead of a failed step', () => {
    const html = renderToStaticMarkup(
      createElement(
        WorkflowCompose,
        {
          canDraft: true,
          editor: createRequestEditor({ text: 'Create a Stripe payment intent', cursor: 32 }),
          graph: createElement(
            'section',
            { 'aria-label': 'Workflow draft graph', className: 'wf-graph' },
            createElement('svg', { className: 'wf-d3-graph' }, 'Create stripe payment intent'),
          ),
          onDraft: vi.fn<() => void>(),
          onEditorChange: vi.fn<(editor: RequestEditor) => void>(),
          onNameChange: vi.fn<(name: string) => void>(),
          showDraft: false,
          workflowName: 'Settle payments',
        },
        createElement(CheckRunError, { error: 'The check runner could not be reached.' }),
      ),
    );

    expect(html).toContain('Checks could not run');
    expect(html).toContain('The check runner could not be reached.');
    expect(html).toContain('Atlas could not finish checks for this version.');
    expect(html).toContain('wf-compose-split');
    expect(html).not.toContain('Checks found a problem');
    expect(html).not.toContain('Run checks');
  });
});
