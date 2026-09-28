# Planner traces

The backend writes one JSONL file here for every authorized
`POST /v1/workflow-drafts` request. JSONL is plain text with one JSON event per
line. A file contains the full path from the submitted workflow text through
model calls, retries, validation, repairs, and the final API response.

The response header `x-atlas-planning-trace-id` matches the `traceId` in every
event and the UUID at the end of the file name.

## Data captured

Each event has:

- `version`, `timestamp`, `sequence`, `traceId`, and `kind`
- the exact incoming planning request
- the exact OpenAI request body, including system prompts and JSON schemas
- the model, endpoint, retry settings, HTTP attempt, timing, and safe headers
- the raw provider response body, parsed output, and provider usage data
- projection and intent fingerprints
- mapping, validation, annotation, clarification, and repair decisions
- the exact final Atlas response or error

Authorization headers and API keys are not written. Their SHA-256 fingerprints
are recorded so runs can still show whether they used the same credential.

## Handling

These files are intentionally visible to Git so experiment branches can commit
them and merge them into one corpus. Use one commit per batch when practical.
File names contain a random UUID, so batches from separate branches should
merge without conflicts.

The files contain raw developer text, capability schemas, model output, and
error details. Treat the repository as sensitive. Before sharing it outside
the experiment group, inspect or remove the trace files.

Generated `.jsonl` files are excluded from Docker image builds, but they are
not ignored by Git. Docker Compose mounts this directory into the backend so
container runs write directly into the checkout.
