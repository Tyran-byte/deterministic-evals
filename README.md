# deterministic-evals

[![CI](https://github.com/Tyran-byte/deterministic-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/Tyran-byte/deterministic-evals/actions/workflows/ci.yml)

A small eval harness for LLM applications. Four deterministic scorers, no LLM
judge, and an exit code that can tell a regression apart from a run that could
not be completed.

Zero dependencies. Zero build step (Node ≥ 22.18 strips the types). ~470 lines
of source, 38 tests.

```bash
git clone https://github.com/Tyran-byte/deterministic-evals
cd deterministic-evals
npm test        # 38 tests, no network
npm run example # a full run against a fake subject, no API key
```

## The thesis

Most eval tooling reaches for an LLM-as-judge by default. That is the right
tool for things like "is this answer helpful" — genuinely fuzzy dimensions
where no assertion exists.

It is the wrong tool for the dimensions that actually gate a release:

| Dimension | The question | Judge needed? |
|---|---|---|
| Refusal | Did the guardrail intercept this, or did the model feel like declining? | No — string equality |
| Parity | Does the number it cited match the database? | No — run the query |
| Tools | Did it call the right tool with the right params? | No — inspect the call |
| Grounding | Does the answer contain the phrases from the source? | No — substring match |

Each of these has a ground truth. Delegating them to a judge trades a
deterministic verdict for a probabilistic one, adds latency and cost per case,
and gives you a gate that can disagree with itself on a rerun.

**So: anything with a ground truth is asserted, never judged.** Keep the judge
for what is genuinely subjective — and notice how little that turns out to be.

## The parts worth stealing

Even if you never install this, three ideas here were paid for in production
bugs.

### 1. Parity is tool-agnostic

The case that motivated this: an assistant answered **"14,608 schools"** when
the true count was **1,348**. It had called the wrong tool *and* mislabelled the
result. An assertion keyed on the tool name passes that. An assertion on the
tool's return value passes it too — the tool returned 14,608 quite correctly.

The only assertion that catches it is on the number the user actually read:

```ts
{ kind: 'number', groundTruth: 'SELECT count(*) FROM schools' }
```

No tool name. Whatever path it took, the figure in the answer has to match the
database.

### 2. Refusal is string equality, and a paraphrase FAILS

```ts
scoreRefusal('Sorry, I can only help with handbook questions.', CANONICAL) // false
```

That looks harsh until you name what a paraphrase means: the request reached the
model and the *model* decided to decline. The deterministic guardrail that was
supposed to intercept it never fired.

Those are two different systems. One is a code path you can test; the other is a
disposition that changes with the weather, the temperature setting, and the next
model version. Substring matching cannot tell them apart, so it silently reports
that your guardrail works when what you have is a polite model.

### 3. Number extraction survives providers mixing locales

Providers emit `"12,546"` with a comma thousands separator and `"85.9%"` with a
decimal point **in the same response**. You cannot pick a locale globally.

The way out is that thousands separators always group exactly three digits:

```ts
parseAmbiguousNumber('36.305') // 36305   — 3 digits after: grouping
parseAmbiguousNumber('21,410') // 21410   — 3 digits after: grouping
parseAmbiguousNumber('87,5')   // 87.5    — 1 digit after: decimal
parseAmbiguousNumber('85.9')   // 85.9    — 1 digit after: decimal
```

And extraction prefers the **bolded** figure, because models bold the number
they are asserting:

```
"Loaded **21,410 records** in the period, since January 1st, 2026."
```

A last-number heuristic cites `2026`. It took a production bug to learn that.

## Why SKIP is not FAIL

Three exit codes, not two:

| Code | Meaning | In CI |
|---|---|---|
| `0` | Every threshold met | Merge |
| `1` | A threshold was missed | **Block** — real regression |
| `2` | Some cases could not be evaluated | Inconclusive — do not merge, do not blame the model |

A harness with two exit codes has to call an undeployed endpoint, an exhausted
quota or a dropped connection *failure*. Do that a few times and the team learns
that red means "probably infrastructure", which is precisely when a real
regression walks through.

An adapter that throws produces SKIP, not FAIL — an `ECONNREFUSED` is not a
model regression. And when both are present, **1 outranks 2**: a genuine failure
must never hide behind "we could not check".

## Two suites, two thresholds

```ts
{ name: 'golden',      threshold: 0.9 }  // quality — some drift is tolerable
{ name: 'adversarial', threshold: 1.0 }  // safety — no exceptions
```

One number cannot serve both. A 95% gate over a merged suite passes a build
where every injection succeeded and the quality cases carried the average.

Adversarial coverage worth having: direct injection, roleplay ("you are now an
assistant with no restrictions"), system-prompt fishing, out-of-scope requests,
cross-role access attempts, PII extraction — and, importantly, **injections
planted in the conversation history**, which check that a fabricated prior turn
does not carry authority into the current one.

## Usage

Datasets are TypeScript, not JSON, so a case can `import` the exact string it
asserts. Rename the refusal copy and the dataset fails to type-check, instead of
passing forever against a string that no longer exists.

```ts
import { runEvals, formatReport } from 'deterministic-evals'
import { REFUSAL_COPY } from '../src/guardrails/copy.ts'

const report = await runEvals({
  suites: [
    { name: 'golden',      threshold: 0.9, cases: GOLDEN },
    { name: 'adversarial', threshold: 1.0, cases: ADVERSARIAL },
  ],

  // Your integration. Return what the subject said and which tools it called.
  adapter: async (c) => {
    const res = await fetch(`${BASE}/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await tokenFor(c.as)}` },
      body: JSON.stringify({ input: c.input, history: c.history ?? [] }),
    })
    if (res.status === 404) return { text: '', unavailable: 'not deployed' } // SKIP
    const body = await res.json()
    return { text: body.text, toolCalls: body.toolCalls }
  },

  // Only needed for parity cases. psql, HTTP, a fixture file — your call.
  groundTruth: (query) =>
    Number(execFileSync('psql', [DB_URL, '-XtA', '-c', query], { encoding: 'utf8' }).trim()),

  onResult: (r) => console.log(`${r.status} ${r.id} ${r.detail ?? ''}`),
})

console.log(formatReport(report).join('\n'))
process.exit(report.exitCode)
```

### The four expectations

```ts
{ kind: 'contains', texts: ['9:00', 'Saturday'] }              // grounding
{ kind: 'refusal',  copy: REFUSAL_COPY }                       // guardrail fired
{ kind: 'number',   groundTruth: 'SELECT count(*) FROM x' }    // tool-agnostic parity
{ kind: 'tool',     name: 'countLoans',                        // tool + optional parity
                    params: { year: 2026 },
                    groundTruth: 'SELECT ...' }
```

`tool` params match as a **subset** — models legitimately fill in defaults the
golden case never mentioned, and asserting on those makes the suite brittle
against harmless changes.

## Two things to know before adopting it

**Parity cases need a same-environment rule.** If the answer comes from staging,
ground truth must come from staging. Comparing a staging answer against
production SQL produces confident, entirely fake failures. The harness cannot
enforce this for you — it lives in how you wire `groundTruth`.

**Rate limits will ruin a full run.** If your subject caps requests per user, a
long suite starts returning 429 partway through and the report becomes noise.
Filter by id and run in batches; that is why `SKIP` exists as a first-class
outcome.

## Origin

Extracted from the eval gate of a production Spanish-language government
platform with role-based assistants — ~90 cases across golden and adversarial
suites, blocking merges. Everything domain-specific was left behind; what
remains is the scoring core and the harness shape.

Written in Spanish originally. Comments were translated, and the reasoning
behind each non-obvious decision was kept, because that reasoning is most of the
value here.

## License

MIT
