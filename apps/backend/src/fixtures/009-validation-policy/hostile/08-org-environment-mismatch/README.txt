No draft/projection/policy mutation; this case is exercised by calling validateWorkflowVersion with context.environmentId = 'env_dev_sandbox' (not in policy.orgEnvironmentRules[org_atlas_demo].allowedEnvironmentIds) against the otherwise-valid fixtures.
Expected diagnostic: policyDenial ORGANIZATION_NOT_AUTHORIZED_FOR_ENVIRONMENT at context.environmentId.
