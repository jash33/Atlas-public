No draft/projection/policy mutation; this case is exercised by calling validateWorkflowVersion with context.proposedApproverRole = 'author' against the otherwise-valid fixtures.
Expected diagnostic: policyDenial RBAC_APPROVER_ROLE_DENIED at context.proposedApproverRole.
