Inserts a new step immediately after step_markInvoicePaid whose errorRouting revalidates back to step_getInvoice, a slice that crosses step_markInvoicePaid's irreversible boundary.
Expected diagnostic: policyDenial REVALIDATION_SLICE_CROSSES_IRREVERSIBLE_BOUNDARY at steps[step_afterMarkPaid_hostileProbe].errorRouting.
