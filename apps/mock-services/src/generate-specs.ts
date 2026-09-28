import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createServiceDocuments } from './documents.js';
import type { BillingSpecMutation } from './contracts.js';

const specsDirectory = fileURLToPath(new URL('../specs/', import.meta.url));
const generatedDocuments = createServiceDocuments();
const files = {
  'payment.openapi.json': generatedDocuments.payment,
  'billing.openapi.json': generatedDocuments.billing,
  'operations.openapi.json': generatedDocuments.operations,
  'events.asyncapi.json': generatedDocuments.events,
  'stripe.openapi.json': generatedDocuments.stripe,
  'slack.openapi.json': generatedDocuments.slack,
  'hubspot.openapi.json': generatedDocuments.hubspot,
};
const billingMutations = [
  'add-optional-field',
  'rename-field',
  'remove-field',
  'retype-field',
] as const satisfies readonly BillingSpecMutation[];

const checkOnly = process.argv.includes('--check');
if (!checkOnly) await mkdir(specsDirectory, { recursive: true });

for (const [fileName, document] of Object.entries(files)) {
  const path = fileURLToPath(new URL(fileName, new URL('../specs/', import.meta.url)));
  const expected = `${JSON.stringify(document, null, 2)}\n`;

  if (checkOnly) {
    const actual = await readFile(path, 'utf8');
    if (actual !== expected) {
      throw new Error(
        `${fileName} is stale; run pnpm --filter @atlas/mock-services specs:generate`,
      );
    }
  } else {
    await writeFile(path, expected);
  }
}

for (const mutation of billingMutations) {
  const mutationDirectory = new URL(`../specs/mutations/${mutation}/`, import.meta.url);
  const path = fileURLToPath(new URL('billing.openapi.json', mutationDirectory));
  const expected = `${JSON.stringify(createServiceDocuments(mutation).billing, null, 2)}\n`;

  if (checkOnly) {
    const actual = await readFile(path, 'utf8');
    if (actual !== expected) {
      throw new Error(
        `${mutation}/billing.openapi.json is stale; run pnpm --filter @atlas/mock-services specs:generate`,
      );
    }
  } else {
    await mkdir(fileURLToPath(mutationDirectory), { recursive: true });
    await writeFile(path, expected);
  }
}
