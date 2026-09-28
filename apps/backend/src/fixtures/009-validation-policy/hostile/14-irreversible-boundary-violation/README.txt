Sets step_markInvoicePaid.irreversibleAfter to false, even though the authorized projection records irreversibleAfter=true for billing-api:markInvoicePaid (Ticket 002's 'never reopen a legitimately paid invoice' rule).
Expected diagnostic: policyDenial IRREVERSIBLE_BOUNDARY_VIOLATION at steps[step_markInvoicePaid].irreversibleAfter.
