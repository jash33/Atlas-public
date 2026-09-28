// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { ValidatedRequestView } from './ValidatedRequestView.js';
import { WorkflowPlanReview } from './WorkflowPlanReview.js';

const planCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../shell.css'),
  'utf8',
);

type PlanProps = Parameters<typeof WorkflowPlanReview>[0];

function planProps(overrides: Partial<PlanProps> = {}): PlanProps {
  return {
    canDraft: true,
    followUp: '',
    hasUnvalidatedChanges: false,
    onFollowUpChange: vi.fn<(value: string) => void>(),
    onRevise: vi.fn<() => void>(),
    onValidateSource: vi.fn<() => void>(),
    onYamlChange: vi.fn<(yaml: string) => void>(),
    yaml: 'workflowVersionId: payment-to-billing@2\n',
    ...overrides,
  };
}

function renderPlan(overrides: Partial<PlanProps> = {}): string {
  return renderToStaticMarkup(createElement(WorkflowPlanReview, planProps(overrides)));
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

function mountPlan(overrides: Partial<PlanProps> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div');
  document.body.append(element);
  container = element;
  const mountedRoot = createRoot(element);
  root = mountedRoot;
  let props = planProps(overrides);
  const render = (next: Partial<PlanProps> = {}) => {
    props = { ...props, ...next };
    act(() => mountedRoot.render(createElement(WorkflowPlanReview, props)));
  };
  render();
  return {
    element,
    render,
    button: (text: string) => {
      const button = [...element.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === text,
      );
      if (!button) throw new Error(`Button not found: ${text}`);
      return button;
    },
  };
}

describe('WorkflowPlanReview', () => {
  it('keeps the inferred request and source below the prompt and graph', () => {
    const html = renderPlan({
      children: createElement(ValidatedRequestView, {
        annotations: [],
        clarifiedRequest: 'Retrieve the payment with getPayment, then notify operations.',
        originalRequest: 'Settle the payment.',
      }),
    });

    expect(html).toContain('Retrieve the payment with getPayment, then notify operations.');
    expect(html).toContain('Inferred request');
    expect(html).toContain('YAML definition');
    expect(html).not.toContain('What should Atlas change?');
    expect(html).not.toContain('Workflow diagram');
    expect(html).not.toContain('Draft graph');
    expect(html).not.toContain('wf-d3-graph');
    expect(html).not.toContain('wf-graph-nodes');
    expect(html).not.toContain('Continue to proposal review');
    expect(html).not.toContain('Ask a follow-up');
    expect(html).not.toContain('Describe a correction');
    expect(html).not.toContain('Workflow Proposal Review');
    expect(html).not.toContain('two views of this exact artifact');
  });

  it('opens directly onto the YAML editor without version or capability summaries', () => {
    const html = renderPlan();
    const sourceAt = html.indexOf('YAML definition');
    const yamlAt = html.indexOf('aria-label="Workflow YAML"');
    const versionAt = html.indexOf('payment-to-billing@2');

    expect(html).toContain('<h3>YAML definition</h3>');
    expect(html).toContain('Validate definition');
    expect(sourceAt).toBeGreaterThan(-1);
    expect(yamlAt).toBeGreaterThan(sourceAt);
    expect(versionAt).toBeGreaterThan(sourceAt);
    const document = new DOMParser().parseFromString(html, 'text/html');
    const source = document.querySelector('[aria-label="Editable workflow YAML"]');
    expect(source?.firstElementChild?.getAttribute('aria-label')).toBe('Workflow YAML');
    expect(source?.querySelector('h4, code, pre')).toBeNull();
    expect(source?.querySelector('textarea')?.value).toBe(
      'workflowVersionId: payment-to-billing@2\n',
    );
  });

  it('lands catalog review on the plan without a proposal gate or a second diagram', () => {
    const html = renderPlan();

    expect(html).toContain('YAML definition');
    expect(html).not.toContain('Workflow diagram');
    expect(html).not.toContain('Draft graph');
    expect(html).not.toContain('Continue to proposal review');
    expect(html).not.toContain('Validated draft');
  });

  it('opens the follow-up from the action row and keeps its text when toggled', () => {
    const onOpenBuilder = vi.fn<() => void>();
    const onRevise = vi.fn<() => void>();
    const plan = mountPlan({
      followUp: 'Wait five minutes before continuing.',
      onOpenBuilder,
      onRevise,
    });
    const toggle = plan.button('Modify with AI');
    expect(plan.element.querySelector('[aria-label="Workflow follow-up"]')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.parentElement).toBe(plan.button('Open in Builder').parentElement);
    act(() => plan.button('Open in Builder').click());
    expect(onOpenBuilder).toHaveBeenCalledOnce();

    act(() => toggle.click());
    const prompt = plan.element.querySelector<HTMLTextAreaElement>(
      '[aria-label="Workflow follow-up"]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(prompt.parentElement?.id).toBe(toggle.getAttribute('aria-controls'));
    expect(prompt.labels?.[0]?.textContent).toBe('What should Atlas change?');
    expect(document.activeElement).toBe(prompt);
    expect(prompt.value).toBe('Wait five minutes before continuing.');
    act(() => plan.button('Propose changes').click());
    expect(onRevise).toHaveBeenCalledOnce();

    act(() => toggle.click());
    expect(plan.element.querySelector('[aria-label="Workflow follow-up"]')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(plan.element.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'Wait five minutes before continuing.',
    );
  });

  it('keeps AI changes gated by validation, permissions, and pending work', () => {
    const onRevise = vi.fn<() => void>();
    const plan = mountPlan({ followUp: 'Add a delay.', hasUnvalidatedChanges: true, onRevise });
    act(() => plan.button('Modify with AI').click());
    expect(plan.button('Propose changes').disabled).toBe(true);
    expect(plan.element.textContent).toContain(
      'Validate your workflow changes before asking AI for another edit.',
    );
    act(() => plan.button('Propose changes').click());
    expect(onRevise).not.toHaveBeenCalled();

    plan.render({ hasUnvalidatedChanges: false, isBusy: true });
    expect(plan.button('Modify with AI').disabled).toBe(true);
    expect(plan.button('Propose changes').disabled).toBe(true);
    expect(plan.element.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    plan.render({ isBusy: false, canDraft: false });
    expect(plan.button('Modify with AI').disabled).toBe(true);
    expect(plan.button('Propose changes').disabled).toBe(true);
    plan.render({ canDraft: true, followUp: '  ' });
    expect(plan.button('Propose changes').disabled).toBe(true);
    plan.render({ followUp: 'Add a delay.' });
    expect(plan.button('Propose changes').disabled).toBe(false);
  });

  it('lets authors edit and validate source, and blocks operators', () => {
    const author = renderPlan();
    const operator = renderPlan({ canDraft: false });

    expect(author).toContain('Validate definition');
    expect(author).toMatch(/<textarea[^>]*aria-label="Workflow YAML"[^>]*>/);
    expect(author).not.toMatch(/<textarea[^>]*aria-label="Workflow YAML"[^>]*disabled=""/);
    expect(operator).toMatch(/<textarea[^>]*aria-label="Workflow YAML"[^>]*disabled=""/);
    expect(operator).toContain('Switch to Author or Admin to edit this workflow.');
    expect(operator).toMatch(/<button[^>]*disabled=""[^>]*>Modify with AI<\/button>/);
  });

  it('distinguishes loading and error states', () => {
    const loading = renderPlan({ isBusy: true });
    const failed = renderPlan({ error: 'Workflow version review could not be loaded' });

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toMatch(/<textarea[^>]*aria-label="Workflow YAML"[^>]*disabled=""/);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Workflow version review could not be loaded');
  });

  it('keeps plan and source controls keyboard-reachable', () => {
    const html = renderPlan();

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain('aria-label="Workflow YAML"');
    expect(html).toContain('<h3>YAML definition</h3>');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('tabindex="-1"');
  });

  it('keeps the plan and source from overflowing on a narrow screen', () => {
    const html = renderPlan();

    expect(html).toContain('class="wf-plan"');
    expect(planCss).toContain('.wf-plan');
    expect(planCss).toMatch(/\.wf-plan[\s\S]*min-width:\s*0/);
    expect(planCss).toMatch(/@media \(max-width: 640px\)[\s\S]*\.wf-plan[\s\S]*min-width:\s*0/);
    expect(planCss).toContain('.wf-plan-source');
  });
});
