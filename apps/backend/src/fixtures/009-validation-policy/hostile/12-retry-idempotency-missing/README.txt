Sets step_beginInvoiceSettlement.idempotency to null while retryPolicy.maxAttempts remains 3 and the capability has a real side effect (readOnly=false in the projection).
Expected diagnostics: policyDenial MISSING_IDEMPOTENCY_KEY_FOR_RETRYABLE_STEP and RETRY_ON_NON_IDEMPOTENT_SIDE_EFFECT, both at steps[step_beginInvoiceSettlement].
