/**
 * The contract shared by every dataset file.
 *
 * A dataset is TypeScript, not JSON, on purpose: cases need to `import` the
 * canonical strings they assert (refusal copy, tool names) instead of
 * duplicating them. A duplicated string is a test that keeps passing after the
 * thing it guards has changed.
 */

/** A prior turn, for multi-turn cases (e.g. an injection planted in the history). */
export interface EvalTurn {
  role: 'user' | 'assistant'
  content: string
}

export type EvalExpectation =
  /** Every listed string must appear in the answer (case- and accent-insensitive). */
  | { kind: 'contains'; texts: string[] }
  /**
   * The agent must have called `name`, and every param listed must match.
   * Subset match: the model may add defaults the case did not ask for.
   */
  | { kind: 'tool'; name: string; params: Record<string, unknown>; groundTruth?: string }
  /**
   * The answer must BE the canonical refusal copy (or start with it).
   * A paraphrased refusal FAILS on purpose — see README, "Why refusal is
   * string equality".
   */
  | { kind: 'refusal'; copy: string }
  /**
   * Tool-agnostic parity: only the CITED NUMBER has to match ground truth, no
   * matter which tool produced it.
   *
   * This exists because of a real bug: the assistant answered "14,608 schools"
   * when the true count was 1,348. It had called the wrong tool AND used the
   * wrong label — an assertion keyed on the tool name would have passed.
   */
  | { kind: 'number'; groundTruth: string }

export interface EvalCase {
  id: string
  /** Which subject under test this case targets — your adapter interprets it. */
  target: string
  input: string
  history?: EvalTurn[]
  /** Caller identity/role, if your adapter authenticates. */
  as?: string
  expect: EvalExpectation
}

/** A tool the subject actually called, as reported by your adapter. */
export interface ToolCall {
  tool: string
  params: Record<string, unknown>
}

/** What the adapter returns for one case. */
export interface SubjectResponse {
  text: string
  toolCalls?: ToolCall[]
  /**
   * Set when the case could not be evaluated at all (subject not deployed,
   * quota exhausted, network down). Produces SKIP, never FAIL — see README,
   * "Why SKIP is not FAIL".
   */
  unavailable?: string
  /** Short-circuit PASS, e.g. the server refused with 403 before reaching the model. */
  passedEarly?: string
}

/** Resolves a ground-truth reference (`groundTruth`) to a number. */
export type GroundTruthResolver = (ref: string) => number | null | Promise<number | null>

export type CaseStatus = 'PASS' | 'FAIL' | 'SKIP'

export interface CaseResult {
  id: string
  target: string
  suite: string
  status: CaseStatus
  detail?: string
}

export interface SuiteReport {
  suite: string
  total: number
  pass: number
  fail: number
  skip: number
  /** pass / (total - skip). NaN when nothing was evaluable. */
  score: number
  /** Minimum score required for this suite. */
  threshold: number
  met: boolean
}

export interface Suite {
  name: string
  cases: EvalCase[]
  /** 1.0 means "no exceptions" — the right value for adversarial suites. */
  threshold: number
}
