import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeGraph, buildGraph, cycleKey, localeKey, resolutionOrder } from '../src/index.mjs'
import { localeRecords } from './helpers.mjs'

const DEPTH = 16

function graphOf(pairs) {
  return buildGraph(localeRecords(pairs))
}

test('a regional chain resolves in a predictable order', () => {
  const graph = graphOf([['en', []], ['pt', ['en']], ['pt-BR', ['pt']]])
  assert.deepEqual(resolutionOrder('pt-br', graph, DEPTH).order, ['pt-br', 'pt', 'en'])
  assert.deepEqual(resolutionOrder('pt', graph, DEPTH).order, ['pt', 'en'])
  assert.deepEqual(resolutionOrder('en', graph, DEPTH).order, ['en'])
})

test('fallback lists are walked depth first, in the declared order', () => {
  const graph = graphOf([['en', []], ['es', ['en']], ['pt', ['en']], ['gl', ['pt', 'es']]])
  assert.deepEqual(resolutionOrder('gl', graph, DEPTH).order, ['gl', 'pt', 'en', 'es'])

  const reordered = graphOf([['en', []], ['es', ['en']], ['pt', ['en']], ['gl', ['es', 'pt']]])
  assert.deepEqual(resolutionOrder('gl', reordered, DEPTH).order, ['gl', 'es', 'en', 'pt'])
})

test('locale tags are matched case insensitively', () => {
  const graph = graphOf([['EN', []], ['pt-br', ['En']]])
  assert.deepEqual(resolutionOrder('pt-br', graph, DEPTH).order, ['pt-br', 'en'])
  assert.deepEqual(resolutionOrder('pt-br', graph, DEPTH).unknown, [])
  assert.equal(localeKey('pt-BR'), 'pt-br')
})

test('a cycle terminates and is reported with its path', () => {
  const graph = graphOf([['en', []], ['pt', ['pt-BR']], ['pt-BR', ['pt']]])
  const result = resolutionOrder('pt', graph, DEPTH)
  assert.deepEqual(result.order, ['pt', 'pt-br'], 'the walk visits each locale once and stops')
  assert.deepEqual(result.cycles, [['pt', 'pt-br', 'pt']])
  assert.deepEqual(result.unknown, [])
})

test('a locale that falls back to itself is a cycle, not an infinite walk', () => {
  const graph = graphOf([['en', ['en']]])
  const result = resolutionOrder('en', graph, DEPTH)
  assert.deepEqual(result.order, ['en'])
  assert.deepEqual(result.cycles, [['en', 'en']])
})

test('a long cycle still terminates', () => {
  const ids = Array.from({ length: 60 }, (_, index) => `l${index}`)
  const pairs = ids.map((id, index) => [id, [ids[(index + 1) % ids.length]]])
  const graph = graphOf(pairs)
  const result = resolutionOrder('l0', graph, 1000)
  assert.equal(result.order.length, 60)
  assert.equal(result.cycles.length, 1)
  assert.deepEqual(result.order[0], 'l0')
})

test('one cycle is reported once, however many locales can reach it', () => {
  const graph = graphOf([['en', []], ['pt', ['pt-BR']], ['pt-BR', ['pt']], ['gl', ['pt']]])
  const analysis = analyzeGraph(graph, { maxDepth: DEPTH })
  assert.equal(analysis.cycles.length, 1)
  assert.deepEqual(analysis.cycles[0].members, ['pt', 'pt-BR', 'pt'])
  assert.equal(cycleKey(['pt', 'pt-br', 'pt']), cycleKey(['pt-br', 'pt', 'pt-br']))
  assert.notEqual(cycleKey(['pt', 'pt-br', 'pt']), cycleKey(['pt', 'en', 'pt']))
})

test('an undeclared fallback target is named and does not stop the walk', () => {
  const graph = graphOf([['en', []], ['fr', ['xx', 'en']]])
  const result = resolutionOrder('fr', graph, DEPTH)
  assert.deepEqual(result.order, ['fr', 'en'])
  assert.deepEqual(result.unknown, [{ fromKey: 'fr', edgeIndex: 0, target: 'xx' }])
})

test('the fallback depth limit is enforced and reported', () => {
  const graph = graphOf([['a', ['b']], ['b', ['c']], ['c', ['d']], ['d', []]])
  const deep = resolutionOrder('a', graph, 4)
  assert.deepEqual(deep.order, ['a', 'b', 'c', 'd'])
  assert.deepEqual(deep.depthExceeded, [])

  const shallow = resolutionOrder('a', graph, 3)
  assert.deepEqual(shallow.order, ['a', 'b', 'c'])
  assert.deepEqual(shallow.depthExceeded, [{ fromKey: 'c', edgeIndex: 0, target: 'd', depth: 4 }])
  assert.throws(() => resolutionOrder('a', graph, 0), /maxDepth/u)
})

test('an edge an earlier edge already reaches is reported as redundant', () => {
  const graph = graphOf([['en', []], ['de', ['en']], ['de-AT', ['de', 'en']]])
  const result = resolutionOrder('de-at', graph, DEPTH)
  assert.deepEqual(result.order, ['de-at', 'de', 'en'])
  assert.deepEqual(result.redundant, [{ fromKey: 'de-at', edgeIndex: 1, target: 'en' }])

  const needed = graphOf([['en', []], ['de', []], ['de-AT', ['de', 'en']]])
  assert.deepEqual(resolutionOrder('de-at', needed, DEPTH).redundant, [], 'the edge is the only way to reach en')
  assert.deepEqual(resolutionOrder('de-at', needed, DEPTH).order, ['de-at', 'de', 'en'])
})

test('a truncated chain is recorded so the audit can refuse to guess', () => {
  const graph = graphOf([['en', []], ['fr', ['xx']], ['ja', []], ['de', ['en']]])
  const analysis = analyzeGraph(graph, { maxDepth: DEPTH })
  assert.equal(analysis.truncated.has('fr'), true)
  assert.equal(analysis.truncated.has('de'), false)
  assert.equal(analysis.truncated.has('ja'), false)
  assert.equal(analysis.truncated.has('en'), false)

  const capped = analyzeGraph(graphOf([['a', ['b']], ['b', ['c']], ['c', []]]), { maxDepth: 2 })
  assert.equal(capped.truncated.has('a'), true)
  assert.equal(capped.truncated.has('b'), false)
})

test('analysis output does not depend on Map insertion order', () => {
  const forward = analyzeGraph(graphOf([['en', []], ['de', ['en']], ['de-AT', ['de', 'en']], ['fr', ['xx']]]), { maxDepth: DEPTH })
  const reversed = analyzeGraph(graphOf([['fr', ['xx']], ['de-AT', ['de', 'en']], ['de', ['en']], ['en', []]]), { maxDepth: DEPTH })
  assert.deepEqual(forward.unknown, reversed.unknown)
  assert.deepEqual(
    forward.redundant.map((entry) => [entry.fromKey, entry.edgeIndex]),
    reversed.redundant.map((entry) => [entry.fromKey, entry.edgeIndex]),
  )
  assert.deepEqual([...forward.orders.get('de-at')], [...reversed.orders.get('de-at')])
})

test('resolving an undeclared locale is a programming error, not a silent empty order', () => {
  const graph = graphOf([['en', []]])
  assert.throws(() => resolutionOrder('nope', graph, DEPTH), /Unknown locale/u)
})
