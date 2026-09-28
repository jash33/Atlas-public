import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

const linkedResourcePattern = /(?:href|src)=["']([^"']+)["']/g;
const siteRoot = dirname(fileURLToPath(import.meta.url));

describe('onboarding site', () => {
  it('keeps every local link and asset resolvable from disk', () => {
    const missingTargets = [];

    for (const page of globSync('**/*.html', {
      cwd: siteRoot,
      exclude: ['dist/**'],
    })) {
      const contents = readFileSync(resolve(siteRoot, page), 'utf8');

      for (const match of contents.matchAll(linkedResourcePattern)) {
        const target = match[1];
        if (
          target === undefined ||
          target.startsWith('#') ||
          target.startsWith('data:') ||
          target.startsWith('http:') ||
          target.startsWith('https:') ||
          target.startsWith('mailto:')
        ) {
          continue;
        }

        const path = target.split('#')[0]?.split('?')[0];
        if (path && !existsSync(resolve(siteRoot, dirname(page), path))) {
          missingTargets.push(`${page} -> ${target}`);
        }
      }
    }

    expect(missingTargets).toEqual([]);
  });

  it('keeps the Console sidebar and Catalog-to-detail journey synchronized', () => {
    const consoleLesson = readFileSync(
      resolve(siteRoot, 'lessons/0001-what-atlas-is.html'),
      'utf8',
    );
    const workflowLesson = readFileSync(resolve(siteRoot, 'lessons/0006-the-runtime.html'), 'utf8');

    for (const surface of [
      'Home',
      'Create Workflow',
      'Workflow Catalog',
      'Capabilities',
      'Runs',
      'Changes',
      'Activity',
      'Settings',
    ]) {
      expect(consoleLesson).toContain(`<td>${surface}</td>`);
    }
    expect(workflowLesson).toContain('Each row links by stable workflow identity');
    expect(workflowLesson).toContain('detail overview separates the active version');
    expect(workflowLesson).toContain('Invoke via API');
    expect(workflowLesson).toContain('POST /ingest');
    expect(workflowLesson).toContain('cannot be invoked until a version is approved and active');
    expect(workflowLesson).toContain('Catalog list has no Run control');
    expect(workflowLesson).not.toContain('guarded run launcher');
    expect(workflowLesson).toContain('Switching environments clears the prior workflow detail');
    expect(workflowLesson).toContain('Draft runs checks automatically once a draft exists');
    expect(workflowLesson).toContain('as the last step in the same drafting progress');
    expect(workflowLesson).toContain(
      'Atlas repairs the draft once from that contract problem and runs checks again',
    );
    expect(workflowLesson).toContain('the graph marks the failed step');
    expect(workflowLesson).toContain('this version is ready to approve');
    expect(workflowLesson).toContain('Approve this version');
    expect(workflowLesson).not.toContain('Evidence Desk');
    expect(workflowLesson).not.toContain('Approve exact artifact');
    expect(workflowLesson).not.toContain('fingerprint');
  });

  it('describes Catalog invoke-via-API and Runs as observation after gateway starts', () => {
    const catalogLesson = readFileSync(resolve(siteRoot, 'lessons/0006-the-runtime.html'), 'utf8');
    const runsLesson = readFileSync(
      resolve(siteRoot, 'lessons/0007-trust-boundaries.html'),
      'utf8',
    );
    const syllabus = readFileSync(resolve(siteRoot, 'lessons/index.html'), 'utf8');

    expect(catalogLesson).toContain('Invoke via API');
    expect(catalogLesson).toContain('required payload fields from that version');
    expect(catalogLesson).toContain('Development on port 4300');
    expect(catalogLesson).toContain('Production on 4301');
    expect(runsLesson).toContain('ingest gateway');
    expect(runsLesson).toContain('POST /ingest');
    expect(runsLesson).toContain('The Console does not start workflows');
    expect(runsLesson).not.toContain('Use Runs to start a workflow');
    expect(syllabus).toContain('Follow runs started through the ingest gateway');
  });

  it('describes Create Workflow as a quiet English compose surface', () => {
    const lesson = readFileSync(resolve(siteRoot, 'lessons/0005-the-ir.html'), 'utf8');
    const syllabus = readFileSync(resolve(siteRoot, 'lessons/index.html'), 'utf8');

    expect(lesson).toContain('quiet compose surface');
    expect(lesson).toContain('a name, a plain-language prompt, and Draft');
    expect(lesson).toContain('no scrolling capability ticker');
    expect(lesson).toContain('highlights it so you can open its details');
    expect(lesson).toContain('After Draft, Atlas continues as a short conversation');
    expect(lesson).toContain('asks a question in ordinary sentences');
    expect(lesson).toContain('names the step or API action when that is already known');
    expect(lesson).toContain('Choose a suggested answer or write your own');
    expect(lesson).toContain('does not guess the missing detail');
    expect(lesson).toContain('switch to Author or Admin to create a workflow');
    expect(lesson).toContain('a graph of that draft stacks underneath the prompt');
    expect(lesson).toContain('stays a conversation without a graph');
    expect(lesson).toContain(
      'steps, order, data mappings, credentials, and irreversible boundaries',
    );
    expect(lesson).toContain('Mappings you asked for look different from mappings Atlas inferred');
    expect(lesson).toContain('amount and currency from the payment record look requested');
    expect(lesson).toContain('idempotency key from the payment id looks inferred');
    expect(lesson).toContain('Every inferred required field uses the same marking');
    expect(lesson).toContain('https://github.com/jash33/Atlas-public/tree/main/docs');
    expect(lesson).not.toContain('irHash');
    expect(lesson).not.toContain('projectionFingerprint');
    expect(lesson).toContain('YAML, follow-up, checks, and approval stay below the graph');
    expect(lesson).toContain('Clicking Draft also runs checks once a draft exists');
    expect(lesson).toContain('as the last step in the same drafting progress');
    expect(lesson).toContain('does not ask for a second Run checks click');
    expect(lesson).toContain(
      'Atlas repairs the draft once from that contract problem and runs checks again',
    );
    expect(lesson).toContain(
      'the chat names the exact error, why it happened, and a suggested fix',
    );
    expect(lesson).toContain('The graph stays visible and marks the failed step');
    expect(lesson).toContain('You can still open the <code>.atlas.yaml</code> authoring source');
    expect(lesson).toContain('Worker never executes that YAML directly');
    expect(lesson).toContain('Saving an edit creates a new workflow version and checks it again');
    expect(syllabus).toContain(
      'Name the integration, describe it in plain language, and answer any questions Atlas asks.',
    );
  });
});
