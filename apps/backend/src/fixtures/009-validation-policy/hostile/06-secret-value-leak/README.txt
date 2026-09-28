Adds a literal mapped field 'apiKey' on step_getPayment shaped like a live Stripe-style secret key.
Expected diagnostic: policyDenial SECRET_VALUE_OR_NON_ALIAS_LEAK at steps[step_getPayment].inputMapping.fields.apiKey. (Also triggers DESTINATION_FIELD_NOT_FOUND since 'apiKey' is not a real request field — both are valid, expected policy denials for this draft.)
