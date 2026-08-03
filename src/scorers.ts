/**
 * Four deterministic scorers and one number extractor. No LLM judge anywhere.
 *
 * Every function here is pure: same inputs, same verdict, forever. That is the
 * whole point — see README, "The thesis".
 */
import type { ToolCall } from './types.ts'

/**
 * Lowercase + strip diacritics. Punctuation is deliberately left alone: the
 * expected strings in `scoreContains` are literal substrings of your source
 * material, and normalizing punctuation would let a near-miss pass.
 */
export function normalizeLite(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
}

/** PASS when every expected string appears in the answer. */
export function scoreContains(answer: string, texts: string[]): boolean {
  const a = normalizeLite(answer)
  return texts.every((t) => a.includes(normalizeLite(t)))
}

function isParamSubset(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([k, v]) => actual?.[k] === v)
}

/**
 * PASS when the subject called the expected tool with at least the expected
 * params. Subset match, because models legitimately fill in defaults the
 * golden case never mentioned.
 */
export function scoreToolMatch(
  toolCalls: ToolCall[],
  expected: { name: string; params: Record<string, unknown> },
): boolean {
  return toolCalls.some((t) => t.tool === expected.name && isParamSubset(expected.params, t.params))
}

/**
 * PASS only when the answer IS the canonical refusal copy, or starts with it.
 *
 * A paraphrased refusal FAILS, and that is not pedantry: it means the model
 * decided to decline, rather than your deterministic guardrail intercepting
 * the request before the model ran. Those are different systems with different
 * reliability, and only one of them is testable. Substring matching here would
 * hide the difference.
 */
export function scoreRefusal(answer: string, canonicalCopy: string): boolean {
  const a = (answer ?? '').trim()
  return a === canonicalCopy || a.startsWith(canonicalCopy)
}

/**
 * PASS when the cited number matches ground truth. Tolerance is 0 for integers
 * and 0.1 for one-decimal percentages.
 *
 * Ground truth is INJECTED. This function touches no database and no network,
 * which is what keeps it unit-testable.
 */
export function scoreParity(
  citedNumber: number,
  groundTruthValue: number,
  kind: 'integer' | 'percentage' = 'integer',
): boolean {
  const tolerance = kind === 'percentage' ? 0.1 : 0
  return Math.abs(citedNumber - groundTruthValue) <= tolerance
}

/** Digits, then zero or more (separator + digits) groups. */
const NUMBER_CORE = String.raw`\d+(?:[.,]\d+)*`
const NUMBER_RE = new RegExp(`${NUMBER_CORE}%?`, 'g')
const PERCENT_RE = new RegExp(`(${NUMBER_CORE})\\s*%`)

/**
 * First number inside **markdown bold**. Models consistently bold the figure
 * they are asserting as the answer, even when real secondary numbers follow.
 *
 * Found the hard way: "Loaded **21,410 records** ... since January 1st, 2026."
 * A last-number heuristic cites "1" or "2026" — the echoed date — and never the
 * figure the assistant actually claimed.
 */
const BOLD_NUM_RE = new RegExp(`\\*\\*[^*]*?(${NUMBER_CORE})%?[^*]*?\\*\\*`)

/**
 * Parse a raw numeric core with ambiguous separators into a `number`.
 *
 * The problem this solves is real and annoying: LLM providers mix locales
 * inside a single response — "12,546" with a comma thousands separator sitting
 * next to "85.9%" with a decimal point. You cannot decide "comma means
 * thousands" globally.
 *
 * The heuristic works because thousands separators ALWAYS group exactly three
 * digits: if the last separator is followed by 3 digits it is a grouping
 * separator; 1 or 2 digits means it is the decimal point. Covers "36.305",
 * "87,5", "21,410" and "85.9" without knowing the provider's locale.
 *
 * Scope, stated honestly: integers (grouped or not) and percentages with one or
 * two decimals. Not for currency with 3+ decimals, and not for scientific
 * notation.
 */
export function parseAmbiguousNumber(raw: string): number {
  const lastSepIdx = Math.max(raw.lastIndexOf('.'), raw.lastIndexOf(','))
  if (lastSepIdx === -1) return Number(raw)

  const afterSeparator = raw.slice(lastSepIdx + 1)
  const isDecimal = afterSeparator.length !== 3
  if (!isDecimal) return Number(raw.replace(/[.,]/g, ''))

  const integerPart = raw.slice(0, lastSepIdx).replace(/[.,]/g, '')
  return Number(`${integerPart}.${afterSeparator}`)
}

/**
 * Pull the number the answer is actually claiming, in priority order:
 * bolded number, then explicit percentage, then last number.
 *
 * `citationMarker` truncates the search: everything from that marker onward is
 * treated as a citation footer and ignored, so IDs and dates in the source
 * attribution never get mistaken for the answer.
 */
export function extractCitedNumber(answer: string, citationMarker = 'Source:'): number | null {
  const idx = answer.indexOf(citationMarker)
  const text = idx === -1 ? answer : answer.slice(0, idx)

  const bold = text.match(BOLD_NUM_RE)
  if (bold) {
    const n = parseAmbiguousNumber(bold[1])
    if (!Number.isNaN(n)) return n
  }

  const pct = text.match(PERCENT_RE)
  if (pct) {
    const n = parseAmbiguousNumber(pct[1])
    if (!Number.isNaN(n)) return n
  }

  const matches = text.match(NUMBER_RE)
  if (!matches || matches.length === 0) return null
  const raw = matches[matches.length - 1].replace('%', '')
  const n = parseAmbiguousNumber(raw)
  return Number.isNaN(n) ? null : n
}

/** Percentages get a tolerance; integers do not. Inferred from the ground-truth ref. */
export function parityKind(groundTruthRef: string): 'integer' | 'percentage' {
  return /%|percent|pct/i.test(groundTruthRef) ? 'percentage' : 'integer'
}
