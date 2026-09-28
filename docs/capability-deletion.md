# Capability deletion

Organization admins can delete a capability from its details in the Capabilities catalog. The confirmation names the operation and selected environment. A successful deletion refreshes the catalog and closes the details drawer. Errors remain visible beside the action.

`DELETE /v1/organizations/:organizationId/environments/:environmentId/capabilities/:capabilityIdentityId` requires organization management permission. It returns `200` on deletion, `403` for unauthorized users, `404` when the capability is absent or already deleted, and `409` if any saved workflow in the organization references a version of that capability.

Migration `079_capability_deletion.cjs` adds deletion metadata to environment observations. Deletion hides the capability from that environment's catalog and makes it unavailable for new compilation. Other environments and historical versions are preserved. The comparison catalog may still show the operation as present in the other environment. Rediscovery cannot clear the deletion or make it available again. The deletion and actor are recorded in the audit log. There is currently no restore action.

Create Workflow also has a **Start over** button. It clears the editor, workflow name, draft, review, checks, traces, and saved recovery state, and creates a new workflow identity. During drafting, it first confirms cancellation with the backend; if cancellation fails, the error stays visible and the draft is retained. The button is disabled during other pending work, such as checks or saving. Saved workflows are not deleted.
