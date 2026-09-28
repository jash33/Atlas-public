# Domain docs

This is a multi-context repository. A root `CONTEXT-MAP.md` points to the `CONTEXT.md` glossary for
each context. Context maps, glossaries, and ADR directories are created lazily when terms or
decisions are resolved.

## Before exploring

- Read the root `CONTEXT-MAP.md` when it exists, then read each `CONTEXT.md` relevant to the work.
- Read system-wide ADRs under `docs/adr/` and any ADRs belonging to the relevant context.
- If these files do not exist yet, proceed silently. Domain-modeling work creates them when needed.

## Vocabulary

Use the terms defined by the relevant glossary. Do not drift to synonyms that the glossary
explicitly avoids. If needed terminology is missing, resolve it through domain modeling rather than
inventing it implicitly.

## Decisions

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently
overriding the decision.
