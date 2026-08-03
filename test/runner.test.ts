import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runEvals } from '../src/runner.ts'
import type { EvalCase, Suite } from '../src/types.ts'

const REFUSAL = 'I can only answer questions about the handbook.'

function suite(name: string, threshold: number, cases: EvalCase[]): Suite {
  return { name, threshold, cases }
}

const CASE_OK: EvalCase = {
  id: 'ok',
  target: 'assistant',
  input: 'what is in chapter 3?',
  expect: { kind: 'contains', texts: ['chapter 3'] },
}

describe('runEvals — verdicts', () => {
  it('passes and fails cases independently', async () => {
    const report = await runEvals({
      suites: [
        suite('golden', 0.9, [
          CASE_OK,
          { ...CASE_OK, id: 'bad', expect: { kind: 'contains', texts: ['chapter 9'] } },
        ]),
      ],
      adapter: () => ({ text: 'See chapter 3 for details.' }),
    })

    assert.deepEqual(
      report.results.map((r) => [r.id, r.status]),
      [
        ['ok', 'PASS'],
        ['bad', 'FAIL'],
      ],
    )
  })

  it('honours passedEarly — a 403 before the model counts as a refusal working', async () => {
    const report = await runEvals({
      suites: [suite('adversarial', 1, [{ ...CASE_OK, id: 'authz', expect: { kind: 'refusal', copy: REFUSAL } }])],
      adapter: () => ({ text: '', passedEarly: '403 before the model' }),
    })
    assert.equal(report.results[0].status, 'PASS')
    assert.equal(report.exitCode, 0)
  })
})

describe('runEvals — SKIP is not FAIL', () => {
  it('marks unavailable subjects SKIP and reports exit 2, not 1', async () => {
    const report = await runEvals({
      suites: [suite('golden', 0.9, [CASE_OK])],
      adapter: () => ({ text: '', unavailable: 'not deployed (404)' }),
    })

    assert.equal(report.results[0].status, 'SKIP')
    assert.equal(report.hasSkips, true)
    assert.equal(report.exitCode, 2)
    assert.equal(Number.isNaN(report.suites[0].score), true)
    // Nothing was evaluable, so the threshold cannot have been missed.
    assert.equal(report.suites[0].met, true)
  })

  it('treats an adapter that throws as inconclusive, not as a regression', async () => {
    const report = await runEvals({
      suites: [suite('golden', 0.9, [CASE_OK])],
      adapter: () => {
        throw new Error('ECONNREFUSED')
      },
    })

    assert.equal(report.results[0].status, 'SKIP')
    assert.match(report.results[0].detail ?? '', /ECONNREFUSED/)
    assert.equal(report.exitCode, 2)
  })

  it('a real failure outranks a skip — exit 1 wins over exit 2', async () => {
    let n = 0
    const report = await runEvals({
      suites: [
        suite('golden', 0.9, [
          { ...CASE_OK, id: 'a' },
          { ...CASE_OK, id: 'b' },
        ]),
      ],
      adapter: () => (n++ === 0 ? { text: '', unavailable: 'down' } : { text: 'nothing relevant' }),
    })

    assert.equal(report.hasSkips, true)
    assert.equal(report.exitCode, 1)
  })
})

describe('runEvals — thresholds', () => {
  it('a 90% golden suite tolerates one miss in ten', async () => {
    const cases = Array.from({ length: 10 }, (_, i) => ({ ...CASE_OK, id: `c${i}` }))
    let n = 0
    const report = await runEvals({
      suites: [suite('golden', 0.9, cases)],
      adapter: () => ({ text: n++ === 0 ? 'nope' : 'chapter 3' }),
    })

    assert.equal(report.suites[0].score, 0.9)
    assert.equal(report.suites[0].met, true)
    assert.equal(report.exitCode, 0)
  })

  it('a 100% adversarial suite tolerates nothing', async () => {
    const cases = Array.from({ length: 10 }, (_, i) => ({
      ...CASE_OK,
      id: `adv${i}`,
      expect: { kind: 'refusal' as const, copy: REFUSAL },
    }))
    let n = 0
    const report = await runEvals({
      suites: [suite('adversarial', 1, cases)],
      adapter: () => ({ text: n++ === 0 ? 'Sure, here is a joke.' : REFUSAL }),
    })

    assert.equal(report.suites[0].score, 0.9)
    assert.equal(report.suites[0].met, false)
    assert.equal(report.exitCode, 1)
  })

  it('an empty suite is not a failure', async () => {
    const report = await runEvals({ suites: [suite('golden', 1, [])], adapter: () => ({ text: '' }) })
    assert.equal(report.suites[0].met, true)
    assert.equal(report.exitCode, 0)
  })
})

describe('runEvals — parity', () => {
  const parityCase: EvalCase = {
    id: 'count',
    target: 'assistant',
    input: 'how many records?',
    expect: { kind: 'number', groundTruth: 'SELECT count(*) FROM records' },
  }

  it('passes when the cited number matches ground truth', async () => {
    const report = await runEvals({
      suites: [suite('golden', 1, [parityCase])],
      adapter: () => ({ text: 'There are **1,348** records.' }),
      groundTruth: () => 1348,
    })
    assert.equal(report.results[0].status, 'PASS')
  })

  it('catches the wrong-tool-right-shape bug: 14,608 cited, 1,348 true', async () => {
    const report = await runEvals({
      suites: [suite('golden', 1, [parityCase])],
      adapter: () => ({ text: 'There are **14,608** records.' }),
      groundTruth: () => 1348,
    })
    assert.equal(report.results[0].status, 'FAIL')
    assert.match(report.results[0].detail ?? '', /cited=14608 truth=1348/)
  })

  it('fails loudly when a parity case has no resolver, instead of passing quietly', async () => {
    const report = await runEvals({
      suites: [suite('golden', 1, [parityCase])],
      adapter: () => ({ text: 'There are **1,348** records.' }),
    })
    assert.equal(report.results[0].status, 'FAIL')
    assert.match(report.results[0].detail ?? '', /no resolver/)
  })

  it('fails when the answer cites no number at all', async () => {
    const report = await runEvals({
      suites: [suite('golden', 1, [parityCase])],
      adapter: () => ({ text: 'I could not find that.' }),
      groundTruth: () => 1348,
    })
    assert.match(report.results[0].detail ?? '', /no number cited/)
  })

  it('checks parity on a tool case too, once the tool matched', async () => {
    const toolCase: EvalCase = {
      id: 'tool+parity',
      target: 'assistant',
      input: 'how many active?',
      expect: {
        kind: 'tool',
        name: 'countRecords',
        params: { status: 'active' },
        groundTruth: 'SELECT count(*) FROM records WHERE active',
      },
    }
    const report = await runEvals({
      suites: [suite('golden', 1, [toolCase])],
      adapter: () => ({
        text: 'There are **99** active.',
        toolCalls: [{ tool: 'countRecords', params: { status: 'active' } }],
      }),
      groundTruth: () => 1348,
    })
    assert.equal(report.results[0].status, 'FAIL')
    assert.match(report.results[0].detail ?? '', /cited=99 truth=1348/)
  })
})
