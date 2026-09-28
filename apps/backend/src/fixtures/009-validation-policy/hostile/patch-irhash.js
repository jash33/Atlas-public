#!/usr/bin/env node
/**
 * Post-process patch applied AFTER generate.js. For every hostile fixture
 * category EXCEPT the ones that specifically test backend-metadata
 * integrity itself (17-tampered-backend-hash, which deliberately
 * leaves a stale irHash; and 16/18 which do not touch payload shape),
 * recompute the correct irHash/workflowIrHash for the MUTATED draft and
 * patch it in place. Without this, every hostile mutation would trip the
 * generic "backend metadata doesn't match its own content" compile
 * error before the pipeline ever reaches the specific gate the fixture is
 * meant to exercise (each hostile fixture must trigger exactly ONE
 * diagnostic category, per the ticket's fixture requirement).
 *
 * Run with: node fixtures/hostile/patch-irhash.js
 * from the prototype root, AFTER `npm run build` and AFTER generate.js.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { recomputeBackendMetadata } = require(path.join(ROOT, ".build", "009-validation-policy", "src", "backend-metadata"));

const SKIP = new Set([
  "16-invalid-cycle", // structural — Ticket 007 itself must reject this before any hash check matters
  "17-tampered-backend-hash", // the whole point of this fixture is a stale hash
  "18-projection-fingerprint-mismatch", // tests projection tampering, not draft tampering
]);

const HOSTILE = path.join(ROOT, "fixtures", "hostile");
for (const name of fs.readdirSync(HOSTILE)) {
  const dir = path.join(HOSTILE, name);
  const draftPath = path.join(dir, "draft.json");
  if (!fs.existsSync(draftPath) || SKIP.has(name)) continue;
  const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  const { recomputedIrHash } = recomputeBackendMetadata(draft);
  draft.version.irHash = recomputedIrHash;
  draft.executionRequirements.workflowIrHash = recomputedIrHash;
  fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2) + "\n");
  console.log(`patched ${name} -> ${recomputedIrHash}`);
}
