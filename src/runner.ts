/**
 * The harness: score a set of cases, aggregate per suite, decide pass/fail.
 *
 * Knows nothing about your model, transport, auth or database. You supply an
 * adapter (how to ask the subject a question) and, if you use parity cases, a
 * ground-truth resolver. Everything else is deterministic and testable without
 * a network.
 */
import {
  extractCitedNumber,
  parityKind,
  scoreContains,
  scoreParity,
  scoreRefusal,
  scoreToolMatch,
} from './scorers.ts'
import type {
  CaseResult,
  EvalCase,
  GroundTruthResolver,
  SubjectResponse,
  Suite,
  SuiteReport,
} from './types.ts'

/** How to ask the subject under test one question. */
export type Adapter = (evalCase: EvalCase) => Promise<SubjectResponse> | SubjectResponse

export interface RunOptions {
  suites: Suite[]
  adapter: Adapter
  groundTruth?: GroundTruthResolver
  /** Text after which the answer is considered a citation footer. */
  citationMarker?: string
  /** Called after each case — wire it to your logger. */
  onResult?: (result: CaseResult) => void
}

export interface RunReport {
  results: CaseResult[]
  suites: SuiteReport[]
  /** Any SKIP at all: the run is inconclusive, not failing. */
  hasSkips: boolean
  /** 0 = all thresholds met · 1 = a threshold was missed · 2 = inconclusive. */
  exitCode: 0 | 1 | 2
}

const MAX_DETAIL = 150

function excerpt(text: string): string {
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL)}…`
}

async function scoreOne(
  evalCase: EvalCase,
  response: SubjectResponse,
  options: RunOptions,
): Promise<{ status: 'PASS' | 'FAIL'; detail?: string }> {
  const { expect } = evalCase
  const text = response.text ?? ''
  const marker = options.citationMarker

  if (expect.kind === 'contains') {
    const pass = scoreContains(text, expect.texts)
    return pass ? { status: 'PASS' } : { status: 'FAIL', detail: `answer: ${excerpt(text)}` }
  }

  if (expect.kind === 'refusal') {
    const pass = scoreRefusal(text, expect.copy)
    return pass ? { status: 'PASS' } : { status: 'FAIL', detail: `answer: ${excerpt(text)}` }
  }

  if (expect.kind === 'number') {
    return checkParity(text, expect.groundTruth, options, marker)
  }

  // expect.kind === 'tool'
  const toolCalls = response.toolCalls ?? []
  if (!scoreToolMatch(toolCalls, { name: expect.name, params: expect.params })) {
    return {
      status: 'FAIL',
      detail: `expected tool "${expect.name}" not matched in ${JSON.stringify(toolCalls)}`,
    }
  }
  if (!expect.groundTruth) return { status: 'PASS' }
  return checkParity(text, expect.groundTruth, options, marker)
}

async function checkParity(
  text: string,
  groundTruthRef: string,
  options: RunOptions,
  marker: string | undefined,
): Promise<{ status: 'PASS' | 'FAIL'; detail?: string }> {
  const cited = extractCitedNumber(text, marker)
  if (cited === null) {
    return { status: 'FAIL', detail: `no number cited — answer: ${excerpt(text)}` }
  }
  if (!options.groundTruth) {
    return { status: 'FAIL', detail: 'case needs groundTruth but no resolver was supplied' }
  }

  const actual = await options.groundTruth(groundTruthRef)
  if (actual === null) {
    return { status: 'FAIL', detail: `ground truth "${groundTruthRef}" resolved to nothing` }
  }

  const pass = scoreParity(cited, actual, parityKind(groundTruthRef))
  return pass
    ? { status: 'PASS' }
    : { status: 'FAIL', detail: `cited=${cited} truth=${actual} — answer: ${excerpt(text)}` }
}

function summarize(results: CaseResult[], suites: Suite[]): SuiteReport[] {
  return suites.map((suite) => {
    const rs = results.filter((r) => r.suite === suite.name)
    const pass = rs.filter((r) => r.status === 'PASS').length
    const fail = rs.filter((r) => r.status === 'FAIL').length
    const skip = rs.filter((r) => r.status === 'SKIP').length
    const total = rs.length
    const evaluable = total - skip
    const score = evaluable === 0 ? NaN : pass / evaluable
    // An empty or fully-skipped suite is not a failure — it is nothing to judge.
    const met = total === 0 || evaluable === 0 || score >= suite.threshold
    return { suite: suite.name, total, pass, fail, skip, score, threshold: suite.threshold, met }
  })
}

export async function runEvals(options: RunOptions): Promise<RunReport> {
  const results: CaseResult[] = []

  for (const suite of options.suites) {
    for (const evalCase of suite.cases) {
      const base = { id: evalCase.id, target: evalCase.target, suite: suite.name }
      let result: CaseResult

      try {
        const response = await options.adapter(evalCase)
        if (response.unavailable) {
          result = { ...base, status: 'SKIP', detail: response.unavailable }
        } else if (response.passedEarly) {
          result = { ...base, status: 'PASS', detail: response.passedEarly }
        } else {
          result = { ...base, ...(await scoreOne(evalCase, response, options)) }
        }
      } catch (error) {
        // An adapter that throws is an infrastructure problem, not a model
        // regression. Inconclusive, not failing.
        result = {
          ...base,
          status: 'SKIP',
          detail: `adapter threw: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      results.push(result)
      options.onResult?.(result)
    }
  }

  const suiteReports = summarize(results, options.suites)
  const hasSkips = results.some((r) => r.status === 'SKIP')
  const allMet = suiteReports.every((s) => s.met)

  // Order matters: a missed threshold is a real regression and outranks an
  // inconclusive run. Reporting 2 here would let a genuine failure look like
  // "we could not check", which is exactly the confusion this scheme exists to
  // prevent.
  const exitCode = !allMet ? 1 : hasSkips ? 2 : 0

  return { results, suites: suiteReports, hasSkips, exitCode }
}

/** Human-readable summary. Returns lines so the caller decides where they go. */
export function formatReport(report: RunReport): string[] {
  const lines: string[] = ['', '── Summary ──']
  for (const s of report.suites) {
    if (s.total === 0) continue
    const score = Number.isNaN(s.score) ? 'n/a' : `${(s.score * 100).toFixed(1)}%`
    const flag = s.met ? 'ok' : 'BELOW THRESHOLD'
    lines.push(
      `${s.suite}: ${s.pass}/${s.total - s.skip} PASS (${s.skip} SKIP of ${s.total}) — ` +
        `score=${score} threshold=${(s.threshold * 100).toFixed(0)}% [${flag}]`,
    )
  }

  if (report.exitCode === 1) lines.push('', 'FAIL — a threshold was missed. exit 1.')
  else if (report.exitCode === 2) lines.push('', 'INCONCLUSIVE — some cases were skipped. exit 2.')
  else lines.push('', 'PASS — all thresholds met. exit 0.')

  return lines
}
