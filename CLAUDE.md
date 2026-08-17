# CLAUDE.md — deterministic-evals

## What this is

A small eval harness for LLM applications: four deterministic scorers (contains,
refusal, number/parity, tool-call), no LLM judge, and a three-way exit code that
tells a real regression apart from a run that simply could not complete. Extracted
from the eval gate of a production platform (`portal-goed-v2`); the domain-specific
parts were stripped, the scoring core and harness shape stayed.

## Stack

- Node ≥ 22.18 (strips TypeScript types natively — no build step, no transpiler).
- **Zero dependencies.** Do not add one without a strong reason; it undercuts the
  whole pitch of the project.
- Layout: `src/` (index.ts, runner.ts, scorers.ts, types.ts), `test/`
  (`*.test.ts`), `examples/` (dataset.ts + run.ts, runnable with no API key).

## Run / test

```bash
npm test        # node --test "test/*.test.ts" — 38 tests, no network
npm run example  # examples/run.ts — full run against a fake subject
```

## This repo is PUBLIC — different rules than Martín's private repos

- **Commit messages in English, no AI co-author trailer.** No
  `Co-Authored-By: Claude ...` or equivalent. This is a showcase repo — the
  commit history itself is part of what it demonstrates, and a co-signed
  history dilutes that signal. (Global default for private repos is the
  opposite: trailer included, Spanish messages. This repo is the exception.)
- If asked in an interview: "the production system was built by me; this
  open-source extraction was done with AI assistance" is the honest framing —
  don't overclaim the repo's authorship story.

## Design invariants (do not casually break these)

- **SKIP ≠ FAIL.** Exit code `0` = pass, `1` = real regression, `2` = some
  cases could not be evaluated (infra issue, not a model issue). When both are
  present, `1` outranks `2` — a genuine failure must never hide behind "we
  could not check".
- **Parity is tool-agnostic**: assert on the number the user actually reads,
  never on which tool produced it or the tool's raw return value.
- **Refusal is exact string equality**, not substring/fuzzy match. A paraphrase
  fails on purpose — it means the model declined, not that a guardrail fired.
- **Two suites, two thresholds** (`golden` ~0.9, `adversarial` 1.0). Never
  merge them into one threshold.

## State

Stable / feature-complete for its stated scope. No open `.planning/` or
`.claude/session-summaries/` in this repo — treat README.md as the source of
truth for behavior and rationale; it is intentionally the long-form doc.

## References

- `README.md` — full pitch, API usage, the "two things to know before
  adopting it" caveats (same-environment rule for parity, rate limits).
- Sibling repo `portal-goed-v2` (private) is where this harness runs in
  production, wired with domain-specific cases.
