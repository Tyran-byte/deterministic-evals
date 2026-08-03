import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractCitedNumber,
  parityKind,
  parseAmbiguousNumber,
  scoreContains,
  scoreParity,
  scoreRefusal,
  scoreToolMatch,
} from '../src/scorers.ts'

describe('scoreContains', () => {
  it('is case- and accent-insensitive', () => {
    assert.equal(scoreContains('El Informe Anual está listo', ['informe anual']), true)
    assert.equal(scoreContains('el informe anual esta listo', ['Informe Anual']), true)
  })

  it('requires every expected string, not just one', () => {
    assert.equal(scoreContains('only the first one', ['first', 'second']), false)
    assert.equal(scoreContains('first and second', ['first', 'second']), true)
  })

  it('does not normalize punctuation, so a near-miss fails', () => {
    assert.equal(scoreContains('the report is ready', ['report, ready']), false)
  })

  it('handles empty and nullish answers without throwing', () => {
    assert.equal(scoreContains('', ['x']), false)
    assert.equal(scoreContains(undefined as unknown as string, ['x']), false)
    assert.equal(scoreContains('anything', []), true)
  })
})

describe('scoreToolMatch', () => {
  const calls = [{ tool: 'countRecords', params: { year: 2026, status: 'active', limit: 50 } }]

  it('matches on a subset of params, ignoring model-added defaults', () => {
    assert.equal(scoreToolMatch(calls, { name: 'countRecords', params: { year: 2026 } }), true)
  })

  it('fails on the wrong tool name even when params line up', () => {
    assert.equal(scoreToolMatch(calls, { name: 'listRecords', params: { year: 2026 } }), false)
  })

  it('fails when an expected param has a different value', () => {
    assert.equal(scoreToolMatch(calls, { name: 'countRecords', params: { year: 2025 } }), false)
  })

  it('fails on an empty call list', () => {
    assert.equal(scoreToolMatch([], { name: 'countRecords', params: {} }), false)
  })
})

describe('scoreRefusal', () => {
  const CANON = 'I can only answer questions about the handbook.'

  it('passes on the exact copy and on the copy plus a suffix', () => {
    assert.equal(scoreRefusal(CANON, CANON), true)
    assert.equal(scoreRefusal(`  ${CANON}  `, CANON), true)
    assert.equal(scoreRefusal(`${CANON} Try asking about chapter 3.`, CANON), true)
  })

  it('FAILS a paraphrase — that means the model declined, not the guardrail', () => {
    assert.equal(scoreRefusal('Sorry, I can only help with handbook questions.', CANON), false)
  })

  it('fails when the copy is merely contained somewhere in the middle', () => {
    assert.equal(scoreRefusal(`Well, ${CANON}`, CANON), false)
  })
})

describe('scoreParity', () => {
  it('is exact for integers', () => {
    assert.equal(scoreParity(1348, 1348), true)
    assert.equal(scoreParity(1349, 1348), false)
  })

  it('allows one decimal of drift for percentages', () => {
    assert.equal(scoreParity(85.9, 85.9, 'percentage'), true)
    assert.equal(scoreParity(85.9, 86.0, 'percentage'), true)
    assert.equal(scoreParity(85.9, 86.1, 'percentage'), false)
  })
})

describe('parseAmbiguousNumber', () => {
  it('reads a 3-digit group as a thousands separator, either locale', () => {
    assert.equal(parseAmbiguousNumber('36.305'), 36305)
    assert.equal(parseAmbiguousNumber('21,410'), 21410)
    assert.equal(parseAmbiguousNumber('1.234.567'), 1234567)
  })

  it('reads 1-2 digits after the last separator as decimals, either locale', () => {
    assert.equal(parseAmbiguousNumber('87,5'), 87.5)
    assert.equal(parseAmbiguousNumber('85.9'), 85.9)
    assert.equal(parseAmbiguousNumber('1.234,56'), 1234.56)
    assert.equal(parseAmbiguousNumber('1,234.56'), 1234.56)
  })

  it('passes through plain integers', () => {
    assert.equal(parseAmbiguousNumber('42'), 42)
  })
})

describe('extractCitedNumber', () => {
  it('prefers the bolded figure over a trailing date — the real 21,410 bug', () => {
    const answer = 'Loaded **21,410 records** in the period, since January 1st, 2026.'
    assert.equal(extractCitedNumber(answer), 21410)
  })

  it('prefers an explicit percentage when nothing is bolded', () => {
    assert.equal(extractCitedNumber('Coverage reached 85.9% across 12 regions.'), 85.9)
  })

  it('falls back to the last number when there is no bold and no percent', () => {
    assert.equal(extractCitedNumber('There are 1348 of them.'), 1348)
  })

  it('ignores everything after the citation marker', () => {
    const answer = 'The total is **1,348**. Source: table 7, row 2026'
    assert.equal(extractCitedNumber(answer), 1348)
  })

  it('honours a custom citation marker', () => {
    const answer = 'The total is 1348. Fuente: tabla 7, fila 2026'
    assert.equal(extractCitedNumber(answer, 'Fuente:'), 1348)
  })

  it('returns null when the answer cites no number at all', () => {
    assert.equal(extractCitedNumber('I could not find that information.'), null)
  })

  it('survives mixed locales in a single answer, which providers really do', () => {
    const answer = 'We processed **12,546** items with 85.9% success.'
    assert.equal(extractCitedNumber(answer), 12546)
  })
})

describe('parityKind', () => {
  it('detects percentages from the ground-truth reference', () => {
    assert.equal(parityKind('SELECT pct_covered FROM stats'), 'percentage')
    assert.equal(parityKind('SELECT percent_done FROM stats'), 'percentage')
    assert.equal(parityKind('coverage %'), 'percentage')
  })

  it('defaults to integer', () => {
    assert.equal(parityKind('SELECT count(*) FROM records'), 'integer')
  })
})
