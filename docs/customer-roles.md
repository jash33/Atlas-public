# Customer roles and access

Atlas has three built-in customer roles. Roles are organization-wide in the MVP; custom roles and separate environment grants are not supported.

| Action                                                                    | Author | Operator | Admin |
| ------------------------------------------------------------------------- | ------ | -------- | ----- |
| View workflows and safe run history                                       | Yes    | Yes      | Yes   |
| Draft or edit workflows and run sandbox checks                            | Yes    | No       | Yes   |
| Start an allowed manual or API run                                        | Yes    | No       | Yes   |
| Retry, resume, cancel, or abandon a run when its state permits it         | No     | Yes      | Yes   |
| Approve safety, activate, approve migrations, or roll back                | No     | No       | Yes   |
| Manage connections, credential references, membership, roles, or settings | No     | No       | Yes   |

## Account mapping

The MVP maps individual verified company accounts, not email addresses or unverified browser data. A mapping joins the configured identity provider's issuer and immutable subject identifier to one Atlas user. That user has exactly one membership role in the customer organization.

A new company account starts with no Atlas access. It creates a pending access request after successful company sign-in. An existing Atlas Admin, or the protected installation command for the first Admin, verifies the person and assigns Author, Operator, or Admin. Provider assignment or a matching email address does not create a mapping. Directory groups may restrict assignment to the Atlas application at the identity provider, but Atlas does not import group roles in this version.

Removing a membership deletes its identity mapping and existing Atlas sessions through database constraints. Changing a role is checked against the live membership record on the next API request. Privileged access therefore stops immediately from Atlas's point of view; no session can retain an old role. The Console may keep showing its last verified role until reload, but the backend denies any newly forbidden action and returns an access message.

## Enforcement

Customer-mode API requests use the secure Atlas session cookie. Bearer tokens, body fields, URL parameters, and browser storage cannot select a human role. Every human request must match the signed-in organization. Any named environment must also exist in that organization. Unknown write routes default to Admin-only.

Worker and gateway credentials are accepted only by the small worker route list. They do not create a browser session, do not map to an organization membership, and cannot authorize a human Admin route.

The append-only audit history records the actor and server time for workflow approval and activation, rollback, role and setting changes, and run repair operations. Completed management, approval, activation, and rollback records carry a successful outcome. Run repair records carry their live or final status and error result.
