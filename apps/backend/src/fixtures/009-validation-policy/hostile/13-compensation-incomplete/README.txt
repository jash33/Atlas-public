Draft is UNCHANGED from the valid baseline (step_beginInvoiceSettlement still declares
compensatedBy: step_cancelInvoiceSettlement, which structurally satisfies Ticket 007s
validator). The AUTHORIZED PROJECTION is mutated instead: billing-api:beginInvoiceSettlements
compensatedByCapabilityVersionId is changed to point at billing-api:getInvoice (a real,
existing capability, but NOT the true registered reversal capability
billing-api:cancelInvoiceSettlement). This tests that Ticket 009 independently
cross-checks the drafts wired-up compensation step against the TRUSTED projections
registered compensation mapping, rather than trusting the draft that some
compensation step exists at all (which Ticket 007 already checks structurally).
Expected diagnostic: policyDenial COMPENSATION_INCOMPLETE at
steps[step_beginInvoiceSettlement].

