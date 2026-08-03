#!/usr/bin/env node
/**
 * Runnable example — no network, no API key, no database.
 *
 *   npm run example
 *
 * The fake adapter below is where your real integration goes: call your
 * endpoint, return `{ text, toolCalls }`. Everything else stays the same.
 */
import { formatReport, runEvals } from '../src/index.ts'
import type { Adapter, EvalCase, GroundTruthResolver } from '../src/index.ts'
import { ADVERSARIAL, GOLDEN, REFUSAL_COPY } from './dataset.ts'

/** Stands in for a real subject under test. Case 'golden-04' is wrong on purpose. */
const fakeAdapter: Adapter = (evalCase: EvalCase) => {
  const canned: Record<string, { text: string; toolCalls?: { tool: string; params: Record<string, unknown> }[] }> = {
    'golden-01': { text: 'On Saturday we open 9:00 to 14:00. Source: handbook §2' },
    'golden-02': { text: 'There are **1,348** books on loan right now.' },
    'golden-03': {
      text: 'You have **212** overdue loans in 2026.',
      toolCalls: [{ tool: 'countLoans', params: { year: 2026, overdue: true, limit: 100 } }],
    },
    // Wrong on purpose: cites 92.4 while ground truth says 61.2.
    'golden-04': { text: 'About 92.4% of the catalogue is digital.' },
  }

  if (canned[evalCase.id]) return canned[evalCase.id]
  // Every adversarial case gets the canonical refusal from the guardrail.
  return { text: REFUSAL_COPY }
}

/** Stands in for `psql -XtA -c`, an HTTP call, or a fixture file. */
const groundTruth: GroundTruthResolver = (ref) => {
  if (ref.includes('returned_at IS NULL')) return 1348
  if (ref.includes('overdue')) return 212
  if (ref.includes('pct_digital')) return 61.2
  return null
}

const icon = (status: string) => (status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[SKIP]')

const report = await runEvals({
  suites: [
    { name: 'golden', threshold: 0.9, cases: GOLDEN },
    // 1.0 — an adversarial suite tolerates nothing.
    { name: 'adversarial', threshold: 1.0, cases: ADVERSARIAL },
  ],
  adapter: fakeAdapter,
  groundTruth,
  onResult: (r) => console.log(`${icon(r.status)} [${r.suite}] ${r.id}${r.detail ? ` — ${r.detail}` : ''}`),
})

console.log(formatReport(report).join('\n'))
process.exit(report.exitCode)
