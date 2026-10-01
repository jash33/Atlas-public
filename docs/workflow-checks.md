# Workflow checks

Steps without an explicit retry policy run once. Retrying a write requires an explicit policy,
a workflow business key, and a capability declaration describing the provider's duplicate
protection. A timeout can mean the provider completed the write even though Atlas received no
response; review that outcome before manually retrying it.

The interpreter registers a step's compensation before calling the provider. An undo operation
must therefore tolerate an absent or already-undone write. Prefer an original input business key
for undo requests: a lost or malformed response may leave no usable output. If required undo data
is unavailable, the run lands in `repair_required` with `CompensationFailed`.
Once an irreversible step is attempted, Atlas preserves earlier effects even if that step loses
its response: it cannot assume the irreversible action did not happen. Sandbox checks use the
same attempted-step rules.

Approved runs have no blanket one-hour execution limit; their declared waits can span days.
Provider calls still have their own timeouts. This change applies to newly started runs, since
Temporal retains the start settings of executions already in progress.

The `register-compensation-before-invoke-v1` Temporal patch preserves the previous behavior when
replaying older runs. Keep that branch until those executions have finished and left retention.

Step results and audit delivery are separate Temporal activities. New runs keep the final
attempt's redacted trace in Temporal and retry its delivery without repeating the provider
operation or delaying compensation. The workflow waits for pending trace delivery before it
closes. Intermediate failed attempts and calls from old histories send best-effort diagnostics;
delivery failure is logged without changing the provider outcome. Trace delivery can repeat,
and the backend stores it by run, step, and attempt. The
`separate-step-attempt-reporting-v1` patch preserves old command histories; retain that branch
until those runs have finished and left retention.

Drafting and checking are separate actions. Saving or editing a draft does not run checks. The Console shows that the version has no current result until an admin chooses **Run checks**.

In the manual builder, **Save draft** stores the current working draft, including incomplete work. **Validate** checks the current canvas without saving it, replacing the saved draft, or running sandbox tests. It can check unsaved changes and unnamed workflows. Approval stores the reviewed version under the workflow's name before activating it.

Checks show a spinner and **Running checks…** while the worker is testing the workflow. The message shows preparation, the current check and capability, and how many checks have finished. Progress comes from the worker and reaches the Console through its one-second status polling; it is not estimated from elapsed time. Cancel remains available, and results from an earlier run stay hidden until the current run finishes. Older workers still return their final results, with a general running message until they finish.

When a capability supports duplicate protection, AI drafting and revalidation add a stable per-step key even when the step has no retry policy. Explicitly declared business keys are preserved. An older draft can receive this default through **Show YAML definition → Validate definition** or **Validate** in Builder; checks then run against the newly validated version.

AI drafting and the manual builder can use a capability's last known definition when discovery fails or its observation becomes stale. The capability stays selectable, with its discovery status visible. Changes to discovery status alone do not invalidate an existing draft. Removed capabilities, conflicting sources, and missing approvals or required metadata still prevent selection.

Creating a draft does not approve it to run. Workflow review and approval still require fresh capability observations and the existing policy checks. A stale capability can be used in a saved workflow version while its approval remains blocked until discovery succeeds.

The Console starts a check request with `PUT /v1/workflow-sandbox-test-requests/:requestId` and reads the same request with `GET`. Repeating the PUT with the same ID and body does not start the work twice. `DELETE` cancels running work. A request reports `running`, `passed`, `failed`, `cancelled`, or `timed_out`; the default time limit is two minutes. Cancellation and timeout are passed to the sandbox worker, and a late result cannot replace either state.

Completed evidence still uses `workflow_sandbox_test_runs`. It names the workflow version and hash, capability versions, generated cases, expected results, test-data and target revisions, worker and runtime versions, and how each check ran. A changed workflow, API contract, test setup, runner, or execution method makes the result stale. Approval requires a current passing result.

Customer sandbox targets must expose the configured reset, fault, and observation controls. Atlas refuses a target on the same origin as the environment's runtime service, both when the target is configured and each time it is selected. A connected internal demo in a development environment can use its own built-in controls when the saved target and test data exactly match its published sandbox settings. This exception does not apply to production environments. Missing target controls, test data, or complete worker evidence fail the check; they cannot produce a pass.
