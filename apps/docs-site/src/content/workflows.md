# Workflows and runs

A workflow is an integration authored and saved in Atlas. It connects approved capabilities into a plan: what runs, in what order, with which data, and what to do when a step fails.

A **run** is one execution of that plan. The same approved workflow can have many runs, each with its own input and progress.

## From intent to a reviewed plan

1. Connect the API definitions and approve the [capabilities](/concepts/capabilities/) the integration needs.
2. As an **Author** or **Admin**, open **Create Workflow**, name the workflow, and describe the outcome in ordinary language.
3. Review the proposed steps and data mappings. Answer questions when information is missing; an unavailable API action needs to be connected before it can be used.
4. Check the exact saved version. Review the result and resolve failures before approval.
5. An **Admin** approves the version and activates it for new runs.

The model proposes a draft. The backend validates it, and a person decides whether it can run. The model does not receive execution credentials or directly execute the workflow.

## What to review

| Part of the plan             | Questions to answer                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| Steps and order              | Are these the intended operations? Which steps depend on earlier results?                 |
| Inputs and mappings          | Where does each required field come from? Are inferred mappings correct?                  |
| Conditions                   | When should a step run, stop, or take another path?                                       |
| Timeouts and retries         | How long may a call take? Is repeating it safe?                                           |
| Writes and recovery          | Can the action be undone? What happens after an irreversible step?                        |
| Credentials and destinations | Does this environment have the required worker, credential references, and allowed hosts? |

The editable `.atlas.yaml` source is a way to inspect and change the plan. Atlas compiles it into a checked execution definition; the worker does not execute arbitrary source code from a prompt.

## Checks, approval, and activation

Checks belong to an exact workflow version and the capability versions and test setup it uses. A changed workflow, API contract, or test setup can make earlier results stale. Approval needs a current passing result.

**Approval** records that a version is acceptable. **Activation** chooses the approved version new runs will use. Editing produces another version that needs its own review. An Author can draft and test, while an Admin controls approval and activation; see [roles and access](/customer-roles/).

## Run an approved version

A worker executes the approved steps using Temporal, which retains execution history and coordinates retries and recovery. Credentials for calling your APIs are supplied to the worker; the Console uses references to them.

For the local evaluation, the [self-hosting guide](/self-host/#try-the-current-local-build) includes a sample request to the ingest gateway. A successful request returns the final step's JSON result. Keep the same idempotency key when repeating the same request, so the gateway refers to the existing execution.

A gateway timeout does not cancel the workflow. Inspect its existing run before submitting more work. Each downstream write also needs reviewed duplicate-handling rules; reusing an intake key alone cannot establish that every provider call is safe to repeat.

## Repair a run

Use **Runs** to inspect progress and the failed step. An **Operator** or **Admin** can use the repair actions available for that run's current state, such as retry, resume, cancel, or abandon.

Check whether earlier steps already produced side effects before choosing an action. Recovery cannot make an irreversible business operation disappear. Repair permissions and allowed actions are enforced by the backend.

## Update a workflow safely

New runs use the active approved version. Runs already in progress retain their original version. Rolling back selects an earlier approved version for future runs; it does not rewrite execution history or undo completed writes.

When a connected API changes, follow the [API change review](/concepts/api-changes/) before activating a replacement.
