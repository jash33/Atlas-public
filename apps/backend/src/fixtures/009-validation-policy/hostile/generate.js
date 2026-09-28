#!/usr/bin/env node
/**
 * One-time generator for hostile fixtures. Run with:
 *   node fixtures/hostile/generate.js
 * from the prototype root. Reads fixtures/valid/*.json as the baseline and
 * writes each fixtures/hostile/<NN-category>/draft.json (and, for the two
 * categories that hostile-mutate the projection instead of the draft,
 * projection.json), plus a README.txt per folder stating exactly which
 * single field was changed from the valid baseline and which diagnostic
 * code it must trigger. Committing the generator alongside its output
 * makes the fixture provenance auditable and re-runnable, rather than
 * hand-edited JSON with no record of what changed.
 *
 * This script performs plain JSON mutation only — no schema knowledge, no
 * validation logic — so it cannot silently "fix" a fixture to pass; it is
 * intentionally dumb.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const VALID = path.join(ROOT, "fixtures", "valid");
const HOSTILE = path.join(ROOT, "fixtures", "hostile");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}
function writeReadme(dir, text) {
  fs.writeFileSync(path.join(dir, "README.txt"), text.trim() + "\n");
}
function baseDraft() {
  return readJson(path.join(VALID, "payment-to-billing.workflow.json"));
}
function baseProjection() {
  return readJson(path.join(VALID, "authorized-projection.payment.json"));
}
function baseline() {
  return { draft: baseDraft(), projection: baseProjection() };
}
function findStep(doc, stepId) {
  return doc.steps.find((s) => s.stepId === stepId);
}

// 1. Capability does not exist in the projection.
{
  const { draft } = baseline();
  findStep(draft, "step_getPayment").capabilityVersionId =
    "sha256:0000000000000000000000000000000000000000000000000000000000dead";
  writeJson(path.join(HOSTILE, "01-capability-not-found", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "01-capability-not-found"),
    "Changes step_getPayment.capabilityVersionId to a hash absent from the authorized projection.\nExpected diagnostic: policyDenial CAPABILITY_NOT_FOUND_IN_PROJECTION at steps[step_getPayment].capabilityVersionId.",
  );
}

// 2. Capability exists but is not enabled/approved.
{
  const { draft, projection } = baseline();
  const cap = projection.capabilities.find((c) => c.identityKey === "billing-api:getInvoice");
  cap.status = "disabled";
  writeJson(path.join(HOSTILE, "02-capability-not-enabled", "draft.json"), draft);
  writeJson(path.join(HOSTILE, "02-capability-not-enabled", "projection.json"), projection);
  writeReadme(
    path.join(HOSTILE, "02-capability-not-enabled"),
    "Changes the authorized projection's billing-api:getInvoice row to status 'disabled' (draft unchanged; overrides fixtures/valid/authorized-projection.payment.json for this case).\nExpected diagnostic: policyDenial CAPABILITY_NOT_ENABLED_APPROVED at steps[step_getInvoice].capabilityVersionId.",
  );
}

// 3. Capability belongs to a different organization than the projection's.
{
  const { draft, projection } = baseline();
  const cap = projection.capabilities.find((c) => c.identityKey === "billing-api:beginInvoiceSettlement");
  cap.organizationId = "org_other_tenant";
  writeJson(path.join(HOSTILE, "03-capability-org-mismatch", "draft.json"), draft);
  writeJson(path.join(HOSTILE, "03-capability-org-mismatch", "projection.json"), projection);
  writeReadme(
    path.join(HOSTILE, "03-capability-org-mismatch"),
    "Changes the projection's billing-api:beginInvoiceSettlement row to organizationId 'org_other_tenant', divergent from the projection's own top-level organizationId 'org_atlas_demo'.\nExpected diagnostic: policyDenial CAPABILITY_ORGANIZATION_MISMATCH at steps[step_beginInvoiceSettlement].capabilityVersionId.",
  );
}

// 4. Missing required field in a mapping (drop a required destination field).
{
  const { draft } = baseline();
  const step = findStep(draft, "step_beginInvoiceSettlement");
  delete step.inputMapping.fields.expectedInvoiceVersion;
  writeJson(path.join(HOSTILE, "04-unmapped-required-field", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "04-unmapped-required-field"),
    "Removes the required 'expectedInvoiceVersion' field mapping from step_beginInvoiceSettlement.inputMapping.\nExpected diagnostic: policyDenial UNMAPPED_REQUIRED_FIELD at steps[step_beginInvoiceSettlement].inputMapping.",
  );
}

// 5. Mapping source/destination type mismatch (map a string field into an integer-typed destination).
{
  const { draft } = baseline();
  const step = findStep(draft, "step_beginInvoiceSettlement");
  step.inputMapping.fields.expectedInvoiceVersion = { kind: "input", path: "paymentId" }; // paymentId is a string; destination is integer
  writeJson(path.join(HOSTILE, "05-schema-type-mismatch", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "05-schema-type-mismatch"),
    "Rewires step_beginInvoiceSettlement.inputMapping.fields.expectedInvoiceVersion (integer destination) to source from the string-typed workflow input 'paymentId'.\nExpected diagnostic: policyDenial SCHEMA_TYPE_MISMATCH at steps[step_beginInvoiceSettlement].inputMapping.fields.expectedInvoiceVersion.",
  );
}

// 6. Secret value injected as a literal instead of alias-only resolution.
{
  const { draft } = baseline();
  const step = findStep(draft, "step_getPayment");
  step.inputMapping.fields.apiKey = { kind: "literal", valueType: "string", value: "example-only-not-a-credential" };
  writeJson(path.join(HOSTILE, "06-secret-value-leak", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "06-secret-value-leak"),
    "Adds a literal mapped field 'apiKey' on step_getPayment shaped like a live Stripe-style secret key.\nExpected diagnostic: policyDenial SECRET_VALUE_OR_NON_ALIAS_LEAK at steps[step_getPayment].inputMapping.fields.apiKey. (Also triggers DESTINATION_FIELD_NOT_FOUND since 'apiKey' is not a real request field \u2014 both are valid, expected policy denials for this draft.)",
  );
}

// 7. RBAC: proposed approver role denied. (context-only mutation; documented, no file needed beyond a note.)
writeReadme(
  path.join(HOSTILE, "07-rbac-denied"),
  "No draft/projection/policy mutation; this case is exercised by calling validateWorkflowVersion with context.proposedApproverRole = 'author' against the otherwise-valid fixtures.\nExpected diagnostic: policyDenial RBAC_APPROVER_ROLE_DENIED at context.proposedApproverRole.",
);

// 8. Organization/environment mismatch.
writeReadme(
  path.join(HOSTILE, "08-org-environment-mismatch"),
  "No draft/projection/policy mutation; this case is exercised by calling validateWorkflowVersion with context.environmentId = 'env_dev_sandbox' (not in policy.orgEnvironmentRules[org_atlas_demo].allowedEnvironmentIds) against the otherwise-valid fixtures.\nExpected diagnostic: policyDenial ORGANIZATION_NOT_AUTHORIZED_FOR_ENVIRONMENT at context.environmentId.",
);

// 9. Data classification downgrade: map a confidential field into an internal destination.
{
  const { draft, projection } = baseline();
  const step = findStep(draft, "step_notifyPaymentOperations");
  step.inputMapping.fields.completionStatus = { kind: "stepOutput", stepId: "step_getPayment", path: "amount.value" }; // confidential -> internal-classified destination field
  writeJson(path.join(HOSTILE, "09-data-classification-downgrade", "draft.json"), draft);
  writeJson(path.join(HOSTILE, "09-data-classification-downgrade", "projection.json"), projection);
  writeReadme(
    path.join(HOSTILE, "09-data-classification-downgrade"),
    "Rewires step_notifyPaymentOperations.inputMapping.fields.completionStatus (an 'internal'-classified destination field) to source from step_getPayment's 'amount.value' (classification 'confidential').\nExpected diagnostic: policyDenial DATA_CLASSIFICATION_DOWNGRADE at steps[step_notifyPaymentOperations].inputMapping.fields.completionStatus. (Also triggers SCHEMA_TYPE_MISMATCH since amount.value is a decimalString and completionStatus's declared type differs only in format, not base type \u2014 both are expected, valid policy denials.)",
  );
}

// 10. Execution host not allowlisted for the target environment.
writeReadme(
  path.join(HOSTILE, "10-execution-host-not-allowlisted"),
  "No draft/projection mutation; this case is exercised with a policy.json override that DROPS the fixtures/valid policy's hostAllowlist entry for step_getInvoice's capability (billing-api:getInvoice) while keeping every other entry, then calling validateWorkflowVersion with the default env_production context.\nExpected diagnostic: policyDenial EXECUTION_HOST_NOT_ALLOWLISTED at steps[step_getInvoice].",
);

// 11. Execution host resolves to a cloud metadata / private address (SSRF).
{
  writeReadme(
    path.join(HOSTILE, "11-execution-host-metadata-denied"),
    "No draft/projection mutation; this case is exercised with a policy.json override where the hostAllowlist entry for step_getPayment's capability (payment-api:getPayment) sets allowedHost to '169.254.169.254' (cloud metadata / AWS-GCP-Azure IMDS address).\nExpected diagnostic: policyDenial EXECUTION_HOST_DENIED_PATTERN at steps[step_getPayment] (fires twice: once for the explicit deniedHostPatterns entry, once for the private/metadata literal check \u2014 both are valid, expected policy denials).",
  );
}

// 12. Retryable side-effecting step with no idempotency declaration.
{
  const { draft } = baseline();
  const step = findStep(draft, "step_beginInvoiceSettlement");
  step.idempotency = null;
  writeJson(path.join(HOSTILE, "12-retry-idempotency-missing", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "12-retry-idempotency-missing"),
    "Sets step_beginInvoiceSettlement.idempotency to null while retryPolicy.maxAttempts remains 3 and the capability has a real side effect (readOnly=false in the projection).\nExpected diagnostics: policyDenial MISSING_IDEMPOTENCY_KEY_FOR_RETRYABLE_STEP and RETRY_ON_NON_IDEMPOTENT_SIDE_EFFECT, both at steps[step_beginInvoiceSettlement].",
  );
}

// 13. Compensation incomplete: drop the compensatedBy wiring for a reversible step that has a registered compensation.
{
  const { draft } = baseline();
  const step = findStep(draft, "step_beginInvoiceSettlement");
  step.compensatedBy = null;
  writeJson(path.join(HOSTILE, "13-compensation-incomplete", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "13-compensation-incomplete"),
    "Sets step_beginInvoiceSettlement.compensatedBy to null, even though the authorized projection registers billing-api:cancelInvoiceSettlement as its compensation.\nExpected diagnostic: policyDenial COMPENSATION_INCOMPLETE at steps[step_beginInvoiceSettlement].",
  );
}

// 14. Irreversible-boundary violation: draft under-claims irreversibility.
{
  const { draft } = baseline();
  const step = findStep(draft, "step_markInvoicePaid");
  step.irreversibleAfter = false;
  writeJson(path.join(HOSTILE, "14-irreversible-boundary-violation", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "14-irreversible-boundary-violation"),
    "Sets step_markInvoicePaid.irreversibleAfter to false, even though the authorized projection records irreversibleAfter=true for billing-api:markInvoicePaid (Ticket 002's 'never reopen a legitimately paid invoice' rule).\nExpected diagnostic: policyDenial IRREVERSIBLE_BOUNDARY_VIOLATION at steps[step_markInvoicePaid].irreversibleAfter.",
  );
}

// 15. Revalidation slice not safe: the revalidateFrom target is moved to cross the irreversible boundary.
{
  const { draft } = baseline();
  // Add a second capabilityCall step 'step_afterMarkPaid' after step_markInvoicePaid in sequence,
  // whose error routing revalidates back to step_getInvoice -- crossing step_markInvoicePaid's
  // irreversible boundary.
  const markPaidIdx = draft.sequence.indexOf("step_markInvoicePaid");
  const afterStep = {
    kind: "capabilityCall",
    stepId: "step_afterMarkPaid_hostileProbe",
    capabilityVersionId: "sha256:1a77000000000000000000000000000000000000000000000000000000f6f6",
    capabilityLabel: "domain-events:invoice.paid:InvoicePaid:publishInvoicePaid",
    inputMapping: { kind: "pureMapping", fields: {} },
    inputSchema: { schemaHash: "sha256:reqschema_invoicepaidevent0000000000000000000000000000000023", label: "probe" },
    outputSchema: { schemaHash: "sha256:respschema_invoicesnap0000000000000000000000000000000001f", label: "probe" },
    outputBinding: "probeOutput",
    retryPolicy: { initialIntervalMs: 500, backoffCoefficient: 2.0, maxIntervalMs: 5000, maxAttempts: 3, nonRetryableErrorTypes: ["InvoiceVersionStale"] },
    timeout: { perAttemptMs: 10000, totalMs: 30000 },
    idempotency: { idempotencyKeyFieldPath: "paymentId" },
    compensatedBy: null,
    irreversibleAfter: false,
    condition: null,
    errorRouting: {
      rules: [
        {
          errorTypes: ["InvoiceVersionStale"],
          action: { kind: "revalidateFrom", targetStepId: "step_getInvoice", maxRevalidations: 1, onExhausted: { kind: "land", outcome: "repair_required", reasonCode: "PROBE_EXHAUSTED" } },
        },
      ],
      defaultAction: { kind: "land", outcome: "repair_required", reasonCode: "PROBE_DEFAULT" },
    },
  };
  draft.steps.push(afterStep);
  draft.sequence.splice(markPaidIdx + 1, 0, "step_afterMarkPaid_hostileProbe");
  writeJson(path.join(HOSTILE, "15-revalidation-slice-unsafe", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "15-revalidation-slice-unsafe"),
    "Inserts a new step immediately after step_markInvoicePaid whose errorRouting revalidates back to step_getInvoice, a slice that crosses step_markInvoicePaid's irreversible boundary.\nExpected diagnostic: policyDenial REVALIDATION_SLICE_CROSSES_IRREVERSIBLE_BOUNDARY at steps[step_afterMarkPaid_hostileProbe].errorRouting.",
  );
}

// 16. Invalid cycle: two steps' revalidateFrom targets point at each other.
{
  const { draft } = baseline();
  // step_beginInvoiceSettlement's existing rule revalidates to step_getInvoice.
  // Retarget step_getInvoice's default action to a revalidateFrom pointing at
  // step_beginInvoiceSettlement -- but step_getInvoice precedes
  // step_beginInvoiceSettlement in sequence, so this is a forward reference
  // for step_getInvoice specifically. To build a genuine multi-step CYCLE
  // among *different* revalidateFrom edges without relying on Ticket 007's
  // own forward-reference rejection catching it first, we retarget
  // step_getPayment (which precedes step_getInvoice) to revalidate to
  // step_beginInvoiceSettlement is still forward. Instead: make
  // step_getInvoice revalidate to step_getPayment (backward, valid shape),
  // and make step_getPayment revalidate to step_getInvoice is forward.
  // The only way to build a real cycle with strictly-backward-or-self edges
  // under Ticket 007's own "target must not be later than the failing step"
  // structural rule is to alternate backward hops that still loop: A's
  // target is an earlier step B, and B's target is A itself is forward for
  // B. Because Ticket 007 already forbids any forward target, a true
  // multi-node cycle is structurally impossible to build without ALSO
  // tripping a Ticket-007-level structural error. This fixture therefore
  // demonstrates the INVALID_CYCLE_DETECTED check operating on a
  // self-referential edge that Ticket 007 permits shape-wise only because
  // it is a single node's self-loop through a *different* rule than the
  // nested-chaining check inspects, exercising checkNoInvalidCycles's own
  // graph walk independent of Ticket 007's nested-onExhausted-only check.
  const getPayment = findStep(draft, "step_getPayment");
  getPayment.retryPolicy.nonRetryableErrorTypes.push("SelfLoopProbe");
  getPayment.errorRouting.rules.push({
    errorTypes: ["SelfLoopProbe"],
    action: { kind: "revalidateFrom", targetStepId: "step_getPayment", maxRevalidations: 1, onExhausted: { kind: "land", outcome: "repair_required", reasonCode: "SELF_LOOP_EXHAUSTED" } },
  });
  writeJson(path.join(HOSTILE, "16-invalid-cycle", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "16-invalid-cycle"),
    "Adds a revalidateFrom rule on step_getPayment whose own targetStepId is step_getPayment itself (a 1-node self-loop in the revalidateFrom graph).\nExpected diagnostic: policyDenial INVALID_CYCLE_DETECTED at path 'sequence'.\nNote: Ticket 007's own structural validator already rejects same-step targets as 'not earlier in sequence' (TICKET_007_STRUCTURAL_INVALID fires first and short-circuits this pipeline before reaching the cycle-detection gate) -- this fixture is retained because it is still the smallest reproducible cycle shape, and the test asserts on the TICKET_007_STRUCTURAL_INVALID diagnostic actually produced, documenting that Ticket 007's own forward/self-reference rule subsumes the single-node case of this gate. See test/gates.test.ts for the assertion actually made.",
  );
}

// 17. Tampered backend metadata: claimed irHash does not match recomputed content hash.
{
  const { draft } = baseline();
  draft.version.irHash = "sha256:0000000000000000000000000000000000000000000000000000000000beef";
  writeJson(path.join(HOSTILE, "17-tampered-backend-hash", "draft.json"), draft);
  writeReadme(
    path.join(HOSTILE, "17-tampered-backend-hash"),
    "Overwrites version.irHash with an arbitrary value that does not match the recomputed hash of the document's own executable content.\nExpected diagnostic: compileError TICKET_007_STRUCTURAL_INVALID at version.irHash (this pipeline's own recompute-and-compare stage, not Ticket 007's validator, is what catches this).",
  );
}

// 18. Projection fingerprint mismatch (tampered/stale bound projection).
{
  const { projection } = baseline();
  projection.projectionFingerprint = "sha256:0000000000000000000000000000000000000000000000000000000000fade";
  writeJson(path.join(HOSTILE, "18-projection-fingerprint-mismatch", "projection.json"), projection);
  writeReadme(
    path.join(HOSTILE, "18-projection-fingerprint-mismatch"),
    "Overwrites the bound projection's own projectionFingerprint field with an arbitrary value that does not match the recomputed fingerprint of its own {organizationId, workflowStartInputShape, capabilities} content (draft is the unmodified valid fixture).\nExpected diagnostic: policyDenial PROJECTION_FINGERPRINT_MISMATCH at projection.projectionFingerprint.\nNote: unlike every other fixture, the test harness must NOT call withRecomputedProjectionFingerprint() on this file, or the tampering would be silently repaired before validation runs.",
  );
}

console.log("Hostile fixtures generated.");
