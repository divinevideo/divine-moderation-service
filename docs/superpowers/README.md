# docs/superpowers — historical planning and design

This directory holds per-PR planning and design artifacts. They are preserved for context, not maintained as current documentation.

## Convention

- `plans/YYYY-MM-DD-<slug>.md` — implementation plans. Typically written before the PR and reflect intent at that point in time.
- `specs/YYYY-MM-DD-<slug>.md` — design specs. Longer-lived than plans but still point-in-time.
- No expectation of ongoing maintenance after the linked PR ships.
- When a doc here and the code disagree, the code wins. Use these as archival context only.

## Why keep them at all

They remain useful for "why did we pick this approach" retrospection, for handoff between contributors, and as context for AI-assisted work. Keeping them in-repo means `git grep` and local tooling find them without GitHub round-trips.

## When to archive differently

If a design doc is durable and meant to evolve with the code (architecture reference rather than PR scaffolding), put it at `docs/` top level instead.
