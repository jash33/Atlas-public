# API changes

Atlas compares connected API contracts when they are rediscovered. It records changed operations and identifies the known workflow steps that use them, so your team can review the impact.

This covers contracts and workflows registered with Atlas. It does not discover every dependency in your company or prove that a running service matches its documentation.

## How changes are classified

| Classification        | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Incompatible contract | A declared field is removed or changes type, or a new required field is added.                         |
| Compatible contract   | The declared structure only has compatible additions.                                                  |
| Metadata changed      | Only descriptive annotations changed.                                                                  |
| Needs review          | The structural change is ambiguous, or runtime evidence exists without a declared-contract difference. |

Atlas compares registered OpenAPI or AsyncAPI operation definitions and their referenced schemas. It does not inspect a service's source code or guarantee its runtime behavior.

## Review the affected work

1. Rediscover the connected contract, or use its configured monitoring.
2. Open **Changes** in the Console and select the change.
3. Compare the old and new operation, changed fields, and affected workflow steps.
4. Check the business consequence with the API owner, including any behavior the contract does not describe.

An incompatible declared contract pauses new affected intake until an approved migration is activated. Existing runs continue with their original versions. Runtime evidence without a contract difference needs further investigation and source rediscovery.

## Test and activate a replacement

Use **Create migration** to propose an updated workflow. Review the new capability versions, mappings, and safety rules; check the new version and resolve failures. An Admin approves and activates the replacement through the normal workflow process.

A change notification is not permission to replace a running workflow automatically. Approval remains a human decision.

## Rehearse with the Payment and Billing example

The local example follows a payment through invoice lookup, amount and currency checks, settlement, event publication, and an operations notification.

Change a field in the connected Billing contract, rediscover it, and inspect the affected workflow. Rehearse the full sequence: identify the changed field, find the dependent step, inspect the pause on new intake, and review a tested replacement. Use local mock APIs and test data for this exercise.

Start with the [local developer installation](/self-host/#try-the-current-local-build).
