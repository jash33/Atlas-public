# GitHub repository contracts

The capability catalog's **Sources** sidebar starts with repositories. Select one to filter the
capabilities on the right, then expand or select its service groups. OpenAPI and AsyncAPI operations
share this tree; document format does not decide the source grouping. Connected repositories remain
visible before they have capabilities. Imports without recorded repository evidence appear under
**Other sources**. A selected connected repository has an **Analysis and ingestion** action for its
saved progress and contract review.

From **Capability catalog → Connect source**, enter a public GitHub repository and the branches to
track. Atlas discovers the API services and their source directories from application code,
including repositories containing multiple services. Customers do not need to supply service
names or directories. The discovered services and source locations appear in contract review.
JavaScript and TypeScript are supported. Atlas reads files at an exact commit, follows shared
code through the analyzer's search/read tools, and never installs or executes repository code.

Configure the backend's existing `OPENAI_MODEL` and `OPENAI_API_KEY_FILE` (or `OPENAI_API_KEY`
when running directly). An optional `GITHUB_TOKEN_FILE` (or `GITHUB_TOKEN`) raises GitHub's read
limit. The Compose configuration mounts the GitHub token only in the backend; put it in the ignored
`.local/github-token` file and set `GITHUB_TOKEN_FILE=../../.local/github-token` in the Compose `.env`.
Customer installations can use their existing `/run/secrets` mount. A token does not enable private
repositories: Atlas verifies public visibility before reading source.

Atlas reports **This repository is either private or unreachable.** when the repository is
private, GitHub returns 404 while opening it, or GitHub cannot be reached. Check its URL and
public visibility. A missing selected branch is reported separately with the branch name.

## Initial ingestion and review

The connection queues a durable analysis. **Repository contracts** opens with a list of connected
repositories, their addresses, tracked branches, latest status, and last check. Choose **View analysis**
to open a repository's saved progress, errors, and actions. Opening the page or selecting a repository
does not request another analysis. Notification links open the named repository directly.

The selected repository shows the result, the proposed
operations and descriptions, request/response definitions, Arazzo sequences, exact source citations,
unresolved questions, and analysis history. Documents can be downloaded as JSON. If code does not
support an operation sequence, the result says so instead of inventing an Arazzo workflow.

The guided view follows five steps: connect, find services, read contracts, check results, and
review. The backend saves stage changes, source-reading activity, discovered-route counts and
drafted-operation counts while analysis runs. The page refreshes these saved updates every five
seconds and preserves the last confirmed results if its connection drops. Counts describe drafts,
not verified contracts or a percentage of total processing time. After two minutes without a worker
update, the page explicitly says progress is uncertain instead of showing an active spinner.

Administrators can opt into team notices for new review candidates and failed checks in the selected
environment's existing notification center. Repeated identical failures do not create duplicate
notices. Notification links reopen repository contracts. This preference does not change deployment
state or source scope. Apply migration `086_repository_analysis_progress` before starting the updated
backend; it stores progress on connections and attempts, plus the notification preference.
Source reload does not apply database updates. The normal `pnpm dev` launcher applies all pending
migrations before starting the backend; an already-running backend can otherwise load new code
against an older database.

The user selected prototype **A — Guided steps**. The three design alternatives and the decision
are preserved on the `prototype/274-repository-contracts-ui` branch for issue #274; the production
page contains no prototype switcher or simulated repository data.

An organization administrator must explicitly accept the exact candidate shown. Atlas records the
reviewer's authenticated identity, time, candidate hash and source commit. Rejected, modified,
superseded and PR candidates cannot be published with an earlier approval. Unresolved questions
must be acknowledged. Source review is separate from safety approval.

Accepted operations enter the existing capability identity/version/provenance tables and the
repository catalog. Generated evidence is labelled `atlas-generated`, with a candidate link and
supporting file/function records; it does not pretend the generated OpenAPI file existed in GitHub.
Structured contracts and approved descriptive fields are stored separately, alongside the full
reviewed documents. Existing versions and review records remain available.

## Periodic checks

The backend checks due connections every five seconds and schedules successful connections for an
hour later. **Check for updates** requests an earlier check. Only selected branches and open PRs
targeting them are considered. Reads are pinned to branch/PR commit IDs. PR results remain previews.

Changed commits are analyzed across the discovered or explicitly configured services, including shared code. Recorded
operation dependencies include validators, handlers, middleware, helpers and database modules.
Saved analysis can be reused when source dependencies remain unchanged; uncertain dependencies
require broader analysis, as described below. Successful extraction for the same commit/model/prompt
can be reused. Unchanged commits and contracts refresh check time without changing accepted definitions.

Periodic review compares only existing operations' request parameters/body and response status
codes, headers and schemas, including referenced definitions and errors. Descriptions, examples,
routes, methods, authentication and Arazzo changes are outside this comparison. Accepted updates
apply only the selected request/response changes. Approved prose and all other saved fields stay
as they were. Missing operations fail the check; they are never inferred to have been removed.

Use **Start a new ingestion** in the always-visible **Ingest new capabilities or revise descriptions** section to explicitly
propose additions or description edits. This requires a new review of the full definitions.

Review shows the previous/proposed contract, changed fields and potentially affected workflow
versions/steps. A per-connection database lock, run keys, retries and commit checks prevent duplicate
or older analysis from replacing current results. Failed/partial checks keep the last successful
documents. Freshness is scoped to the repository connection and shown separately from approval.

## Source contracts and deployed services

Repository connection, PR analysis, branch checks and review acceptance do not change deployment
observations, execution addresses, host policies, worker secrets, workflow approvals or quarantines.
To execute an accepted API, independently confirm the deployed definition using the existing
environment source-confirmation flow, and configure the execution address, host approval, safety
annotations and any sandbox targets. The running Burger Town connection remains available for
those explicit demo settings.

Arazzo versions are selected per source/service/scope, so separate services retain their own
recipes and history. Periodic checks preserve the initially approved Arazzo document. Explicit
new ingestion may propose another recipe version for human review.

## Verification

The tests cover human approval and exact candidate binding, source-only publication, description
preservation, normalized comparisons, shared-code changes, unmatched operations, PR isolation,
workflow impact, multiple services/branches, retained history, retries, duplicate/outdated runs,
branch reversion, and explicit re-ingestion. They use a separate PostgreSQL database.

A live public-source extraction passed on `honojs/examples`, commit
`3b0b62875a0e1265763fea1c6388866d5697ef81`, service root `nextjs-stack/pages/api`, using the configured
`gpt-5.6-luna` model. It discovered `POST /api/hello`, its required form field `name`, JSON response
field `message`, source-supported descriptions and citations, and explicit questions about behavior
inside external dependencies. No catalog or deployment was approved by that check.

Generated contracts still require review against source definitions and tests. The extractor
must resolve differences in optional fields, constraints, and error responses using source
evidence, or identify those differences explicitly for human review. A successful extraction
does not approve a catalog or establish production readiness.

After building the backend, a public-source extraction can be reproduced with model/key environment
variables set (file paths are relative to the current directory):

```sh
node tooling/analyze-repository.mjs https://github.com/honojs/examples main nextjs-example nextjs-stack/pages/api repository-analysis.json
```

The script saves drafts and validation results only. It cannot approve catalog entries.

The integration follows the official [GitHub tree API](https://docs.github.com/en/rest/git/trees)
and [OpenAI function-calling API](https://developers.openai.com/api/docs/guides/function-calling).
Model responses [stream as they are generated](https://developers.openai.com/api/docs/guides/streaming-responses),
so large drafts can arrive without waiting for the whole document before the response begins.
Invalid file-read arguments are returned to the analyzer for correction. Partial submissions can
continue reading missing local code within the same correction limit. Citations may span adjacent
file reads, but every cited line must have been read. Draft corrections can edit individual sections;
every corrected draft goes through the same validation and human-review requirements.
The analyzer builds large documents in smaller sections: at most three operations, five component
definitions, or two workflows per call. Atlas assembles those sections into OpenAPI and Arazzo,
then validates the complete documents and their citations. Interrupted generation retains the
unfinished sections for inspection.

The analyzer declares the operation and workflow IDs found in source. Missing declared
definitions and explicit incomplete results cannot finish successfully. Existing JSON/YAML
OpenAPI or Arazzo documents can supply exact definitions after their operations have been traced
in code. Extra generated operations and code evidence are retained. Review lists the supporting
document paths and the analyzer's explanation. Differences from a valid OpenAPI document at the
service or single-service repository root must be resolved or named in the review questions.

Files are limited to 750 KB each, 12 MB of analyzed source, and 2,500 supported source files per
repository. Truncated trees, rate limits and exhausted analysis budgets are failures with retained
last-known results. The model gets at most 180 rounds, 240 tool calls, five document corrections,
and 20 minutes per extraction.

## Focused analysis and reuse

When no service selection is supplied, extraction first identifies the repository's API applications
and their source directories. Each must have exact application-code evidence. Shared libraries
remain dependencies, and existing accepted service IDs must be preserved. This discovery uses the
same model and analysis budget. Existing API clients can still supply an explicit service selection.

Extraction then discovers each service's operation and workflow IDs. Atlas assigns
groups of at most three operations or two workflows, with a fresh conversation for each group.
The model still follows arbitrary application code, including homegrown validation and response
construction. There is no framework or validation-library requirement.

The model can save short findings about route locations and shared behavior with exact source
citations and dependency paths. Later groups retrieve those findings instead of repeating the
investigation. File lists and finding searches are paginated. Generated documents stay in the
backend; tool responses do not repeat whole documents. Long conversations restart from saved
progress and the latest complete tool exchange after 48,000 characters. A run stops before
sending more than 100,000 conversation characters in one request or 2,000,000 cumulatively;
each response is limited to 16,000 output tokens. These are work limits, not price guarantees.

Migration 085 stores analysis memory separately from reviewable contracts. Checkpoints survive
interruptions. Unchanged source-backed findings can be reused, and successfully completed
operations can be reused when their dependencies were fully traced. Every analysis reconfirms
the route inventory and service review. Changed shared helpers invalidate dependent operations;
changed shared components invalidate their service's operations. Routing changes, new or removed
files, configuration, dependency lockfiles, or previously untraced changes trigger broader analysis.
Lockfile versions are tracked without sending their contents to the model. An omitted route is
removed from the reused draft so the existing missing-operation check still applies.

Reuse is separated by repository connection, branch or pull request, model, extractor and prompt
version, and ingestion generation. Source ranges are checked again before reused evidence is
accepted. Uncertain dependency coverage causes full operation analysis. Saved findings never
approve or publish a contract; normal document checks and explicit human review still apply.

The focused-analysis tests use scripted model responses, including homegrown validators and
shared-code changes. The test setup blocks external fetches. No live AI-provider requests were
made to validate this change, and its real token savings and extraction accuracy remain unmeasured.
