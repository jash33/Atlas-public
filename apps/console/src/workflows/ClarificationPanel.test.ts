import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { ClarificationPanel } from './ClarificationPanel.js';

const composeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../shell.css'),
  'utf8',
);

describe('ClarificationPanel', () => {
  it('shows a mapping preview only for a deterministically verified answer', () => {
    const html = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: true,
        disabled: false,
        diagnostics: [
          {
            code: 'SOURCE_PATH_NOT_FOUND',
            path: 'executable.steps[get-payment].arguments.paymentId',
            message: "Source path 'paymentId' is absent from the pinned schema.",
          },
        ],
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question:
          'What should Atlas use for the PostPaymentIntents request field amount in the Stripe API?',
        questionAnnotations: [
          {
            start: 30,
            end: 48,
            text: 'PostPaymentIntents',
            kind: 'capability',
            capabilityVersionId: 'cap-stripe-payment-intents',
            evidence: {
              projectionFingerprint: 'b'.repeat(64),
              capabilityVersionId: 'cap-stripe-payment-intents',
              matchedTerms: ['postpaymentintents'],
            },
          },
        ],
        suggestedAnswers: ['Use getPayment response field amount.value'],
        suggestedAnswerAnnotations: [
          {
            answer: 'Use getPayment response field amount.value',
            annotations: [
              {
                start: 4,
                end: 14,
                text: 'getPayment',
                kind: 'capability',
                capabilityVersionId: 'cap-get-payment',
                evidence: {
                  projectionFingerprint: 'b'.repeat(64),
                  capabilityVersionId: 'cap-get-payment',
                  matchedTerms: ['getpayment'],
                },
              },
              {
                start: 37,
                end: 42,
                text: 'value',
                kind: 'responseField',
                capabilityVersionId: 'cap-get-payment',
                direction: 'response',
                path: '/amount/value',
                evidence: {
                  projectionFingerprint: 'b'.repeat(64),
                  capabilityVersionId: 'cap-get-payment',
                  path: '/amount/value',
                  matchedTerms: ['value'],
                },
              },
            ],
          },
        ],
        suggestedAnswerSelections: [
          {
            answer: 'Use getPayment response field amount.value',
            candidateId: 'amount<-step:get-payment:amount.value:convert',
            destinationPath: ['amount'],
          },
        ],
        mapping: {
          intentFingerprint: 'a'.repeat(64),
          projectionFingerprint: 'b'.repeat(64),
          sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'cap-get-payment' }],
          destinationCapabilityVersionId: 'cap-stripe-payment-intents',
          destinationStepId: 'create-payment-intent',
          history: [],
        },
        identities: [
          {
            capabilityVersionId: 'cap-get-payment',
            serviceId: 'payments',
            operationId: 'getPayment',
          },
          {
            capabilityVersionId: 'cap-stripe-payment-intents',
            serviceId: 'stripe',
            operationId: 'PostPaymentIntents',
          },
        ],
      }),
    );

    expect(html).toContain('>getPayment</mark>');
    expect(html).toContain('response field amount.');
    expect(html).toContain('>value</mark>');
    expect(html).toContain('Write my own');
    expect(html).toContain('<mark');
    expect(html).toContain('payments · getPayment');
    expect(html).toContain('stripe · PostPaymentIntents');
    expect(html).toContain('Technical details');
    expect(html).toContain('SOURCE_PATH_NOT_FOUND');
    expect(html).toContain('wf-clarification-option');
    expect(html.match(/class="wf-clarification-preview"/g)).toHaveLength(1);
    expect(html).toContain('PostPaymentIntents');
    expect(html).toContain('Mapping only');
    expect(html).not.toContain('wf-transcript');
    expect(html).not.toContain('<textarea');
    expect(html).toContain('What should Atlas use for the');
    expect(html).toContain('request field amount');
    expect(html.indexOf('SOURCE_PATH_NOT_FOUND')).toBeGreaterThan(
      html.indexOf('Technical details'),
    );
    expect(html).not.toContain('backend-verified mappings');
  });

  it('tells an Operator to switch roles instead of explaining the control plane', () => {
    const html = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: false,
        disabled: false,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: 'Which payment should Atlas read with getPayment?',
        suggestedAnswers: ['The current payment'],
      }),
    );

    expect(html).toContain('Switch to Author or Admin to create a workflow');
    expect(html).not.toContain('Switch to Author or Admin to answer this question.');
    expect(html).not.toContain('control plane');
    expect(html).not.toContain('Operators cannot draft.');
    expect(html).not.toContain('wf-clarification-option');
  });

  it('keeps suggested answers as buttons, including Write my own', () => {
    const html = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: true,
        disabled: false,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: 'How should Atlas adapt this workflow?',
        suggestedAnswers: [
          'Switch to production and review this request',
          'Keep the valid parts and omit unavailable operations',
        ],
      }),
    );

    expect(html).toContain('aria-label="Suggested answers"');
    expect(html).toContain('type="button"');
    expect(html).toContain('Switch to production and review this request');
    expect(html).toContain('Keep the valid parts and omit unavailable operations');
    expect(html).toContain('Write my own');
    expect(html).toContain('wf-clarification-option');
    expect(html).not.toContain('tabindex="-1"');
  });

  it('distinguishes empty and busy clarification states', () => {
    const empty = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: true,
        disabled: false,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: 'Which payment should Atlas read?',
        suggestedAnswers: [],
      }),
    );
    const busy = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: 'The current payment',
        canDraft: true,
        disabled: true,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: 'Which payment should Atlas read?',
        suggestedAnswers: ['The current payment'],
      }),
    );

    expect(empty).toContain('for="workflow-clarification-answer"');
    expect(empty).toContain('id="workflow-clarification-answer"');
    expect(empty).toContain('disabled=""');
    expect(empty).toContain('>Submit answer<');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('disabled=""');
  });

  it('keeps clarification questions keyboard-reachable', () => {
    const html = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: true,
        disabled: false,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: 'What should Atlas use for the PostPaymentIntents request field amount?',
        suggestedAnswers: ['Use getPayment response field amount.value'],
      }),
    );

    expect(html).toContain('aria-label="Suggested answers"');
    expect(html).toContain('type="button"');
    expect(html).toContain('>Write my own<');
    expect(html).not.toContain('tabindex="-1"');
  });

  it('keeps clarification options from overflowing on a narrow screen', () => {
    const html = renderToStaticMarkup(
      createElement(ClarificationPanel, {
        answer: '',
        canDraft: true,
        disabled: false,
        onAnswerChange: () => undefined,
        onSubmitAnswer: () => undefined,
        question: 'Which payment should Atlas read?',
        suggestedAnswers: ['The current payment'],
      }),
    );

    expect(html).toContain('class="wf-clarification"');
    expect(composeCss).toContain('.wf-compose .wf-clarification');
    expect(composeCss).toMatch(/\.wf-compose[\s\S]*\.wf-clarification[\s\S]*min-width:\s*0/);
    expect(composeCss).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.wf-compose[\s\S]*\.wf-clarification[\s\S]*min-width:\s*0/,
    );
  });
});
