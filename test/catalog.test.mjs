import assert from 'node:assert/strict'
import test from 'node:test'

import { flattenCatalog, isPlainObject, isUsable, placeholdersIn, typeNameOf, usableKeys } from '../src/index.mjs'

const LIMITS = { maxDepth: 12, maxKeys: 20000 }

test('nested objects flatten to dotted keys', () => {
  const flat = flattenCatalog({ legal: { terms: 'a', sub: { deep: 'b' } }, top: 'c' }, LIMITS)
  assert.deepEqual([...flat.values.keys()].sort(), ['legal.sub.deep', 'legal.terms', 'top'])
  assert.equal(flat.values.get('legal.sub.deep'), 'b')
  assert.equal(flat.keysFound, 3)
  assert.equal(flat.overflow, false)
  assert.deepEqual(flat.duplicates, [])
  assert.deepEqual(flat.nonStrings, [])
  assert.deepEqual(flat.tooDeep, [])
})

test('an already dotted key is kept as written', () => {
  const flat = flattenCatalog({ 'legal.terms': 'a' }, LIMITS)
  assert.deepEqual([...flat.values.keys()], ['legal.terms'])
})

test('two paths to one key are reported, not silently merged', () => {
  const flat = flattenCatalog({ 'legal.terms': 'dotted', legal: { terms: 'nested' } }, LIMITS)
  assert.deepEqual(flat.duplicates, ['legal.terms'])
  assert.equal(flat.values.get('legal.terms'), 'dotted', 'the first path wins and the finding says so')
  assert.equal(flat.values.size, 1)
})

test('the depth limit is enforced and names what was not read', () => {
  const document = { a: { b: { c: { d: 'deep' } } } }
  const deep = flattenCatalog(document, { ...LIMITS, maxDepth: 4 })
  assert.deepEqual([...deep.values.keys()], ['a.b.c.d'])
  assert.deepEqual(deep.tooDeep, [])

  const shallow = flattenCatalog(document, { ...LIMITS, maxDepth: 3 })
  assert.deepEqual(shallow.tooDeep, ['a.b.c'])
  assert.equal(shallow.values.size, 0, 'the subtree below the limit is not read')

  const atOne = flattenCatalog(document, { ...LIMITS, maxDepth: 1 })
  assert.deepEqual(atOne.tooDeep, ['a'])
})

test('the key limit is exceeded rather than silently truncated', () => {
  const document = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, 'v']))
  const under = flattenCatalog(document, { ...LIMITS, maxKeys: 30 })
  assert.equal(under.overflow, false)
  assert.equal(under.values.size, 30)

  const over = flattenCatalog(document, { ...LIMITS, maxKeys: 29 })
  assert.equal(over.overflow, true)
  assert.ok(over.values.size <= 29, 'nothing beyond the limit is retained for the caller to use')
})

test('non-string values are separated from translations rather than coerced', () => {
  const flat = flattenCatalog({ n: 1, b: true, nul: null, arr: ['a'], ok: 'text' }, LIMITS)
  assert.deepEqual(flat.nonStrings, [
    { key: 'arr', type: 'array' },
    { key: 'b', type: 'boolean' },
    { key: 'n', type: 'number' },
    { key: 'nul', type: 'null' },
  ])
  assert.deepEqual([...flat.values.keys()], ['ok'])
})

test('a catalog key named like an object member is data, not a member', () => {
  const document = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": "c", "toString": "t"}')
  const flat = flattenCatalog(document, LIMITS)
  assert.equal(flat.values instanceof Map, true, 'never a plain object')
  assert.equal(flat.values.get('constructor'), 'c')
  assert.equal(flat.values.get('toString'), 't')
  assert.equal(flat.values.get('__proto__.polluted'), 'yes', 'the nested key flattens to ordinary readable data')
  assert.equal(flat.values.size, 3)

  // Asserting ({}).polluted is undefined here would prove nothing: the
  // flattener builds '__proto__.polluted' as one ordinary string, so even a
  // deliberately unsafe plain-object store would write a normal own property
  // and never touch a shared prototype. What a plain-object store would do is
  // lose the key, because assigning to __proto__ calls a setter instead of
  // writing a property, so that is what is asserted.
  const direct = flattenCatalog(JSON.parse('{"__proto__": "own value", "legal": {"terms": "Accept."}}'), LIMITS)
  assert.equal(direct.values.get('__proto__'), 'own value', 'a key literally named __proto__ is kept as written')
  assert.deepEqual([...direct.values.keys()].sort(), ['__proto__', 'legal.terms'])
  assert.equal(usableKeys(direct.values).includes('__proto__'), true, 'and it is audited like any other key')
  assert.equal(Object.getPrototypeOf(direct.values), Map.prototype)
})

test('a deep document does not overflow the call stack before the limit is reached', () => {
  let node = { leaf: 'end' }
  for (let depth = 0; depth < 50000; depth += 1) node = { n: node }
  const flat = flattenCatalog(node, { maxDepth: 40, maxKeys: 10 })
  assert.deepEqual(flat.tooDeep, [Array.from({ length: 40 }, () => 'n').join('.')])
  assert.equal(flat.values.size, 0)
})

test('placeholders are the distinct names in code unit order', () => {
  assert.deepEqual(placeholdersIn('Total {amount} on {date}'), ['amount', 'date'])
  assert.deepEqual(placeholdersIn('{b} {a} {b}'), ['a', 'b'])
  assert.deepEqual(placeholdersIn('none here'), [])
  assert.deepEqual(placeholdersIn('{first-name} and {user_id} and {a.b}'), ['a.b', 'first-name', 'user_id'])
  assert.deepEqual(placeholdersIn('{{name}}'), ['name'], 'a mustache contains the simple argument')
  assert.deepEqual(placeholdersIn('{ spaced }'), [], 'only the documented shape is recognised')
  assert.deepEqual(placeholdersIn('unterminated {name'), [])
  assert.deepEqual(placeholdersIn('%s and %1$s'), [], 'printf style is a documented non-goal')
  assert.deepEqual(placeholdersIn('$t(legal.terms)'), [], '$t(key) is a documented non-goal')
  assert.deepEqual(placeholdersIn('<0>bold</0>'), [], 'tag markup is a documented non-goal')
})

test('an ICU plural, select or selectordinal body yields no placeholder at all', () => {
  // Each branch body below is identifier shaped -- {He}, {items}, {th} -- and a
  // scan that only looked for {name} would read every one of them as a
  // placeholder, so a correct translation of a select would be failed twice:
  // once for "dropping" the source branches and once for "inventing" its own.
  assert.deepEqual(placeholdersIn('{gender, select, male {He} female {She} other {They}}'), [])
  assert.deepEqual(placeholdersIn('{count, plural, one {item} other {items}}'), [])
  assert.deepEqual(placeholdersIn('{n, selectordinal, one {st} two {nd} other {th}}'), [])
  assert.deepEqual(placeholdersIn('{count,plural,one{item}other{items}}'), [], 'no whitespace is still ICU')
  assert.deepEqual(placeholdersIn('{ count , plural , one {item} other {items} }'), [], 'padded is still ICU')
  assert.deepEqual(placeholdersIn('{count, plural, one {# item} other {# items}}'), [])
  assert.deepEqual(placeholdersIn('{outer, select, other {{inner} text}}'), [], 'a nested argument is skipped with its branch')

  // The complex argument is skipped, and nothing around it is.
  assert.deepEqual(
    placeholdersIn('{n, plural, one {message} other {messages}} for {user} in {inbox}'),
    ['inbox', 'user'],
  )
  assert.deepEqual(placeholdersIn('{a}{b, plural, one {x} other {y}}{c}'), ['a', 'c'])
  assert.deepEqual(placeholdersIn('{gender, select, male {He} other {They}'), [], 'an unterminated select is not mined for branches')
  assert.deepEqual(placeholdersIn('{amount, number, ::.00}'), [], 'a formatted argument is not a simple argument')
})

test('the placeholder scan is linear, not a nesting-depth recursion', () => {
  // A value is bounded by maxCatalogBytes, not by how deeply it nests braces,
  // so the scan must not put one frame on the stack per brace.
  const nested = '{'.repeat(200000) + 'name}' + '}'.repeat(199999)
  assert.deepEqual(placeholdersIn(nested), ['name'])
  assert.deepEqual(placeholdersIn('{'.repeat(200000)), [])
})

test('a blank value is not a translation', () => {
  assert.equal(isUsable('text'), true)
  assert.equal(isUsable(''), false)
  assert.equal(isUsable('   '), false)
  assert.equal(isUsable('\t\n'), false)
  assert.equal(isUsable(undefined), false)
  assert.equal(isUsable(7), false)

  const values = new Map([['a', 'text'], ['b', ''], ['c', '  '], ['d', 'more']])
  assert.deepEqual(usableKeys(values), ['a', 'd'])
})

test('plain object and type naming behave as the flattener assumes', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject('s'), false)
  assert.equal(typeNameOf(null), 'null')
  assert.equal(typeNameOf([]), 'array')
  assert.equal(typeNameOf(1), 'number')
  assert.equal(typeNameOf('s'), 'string')
})

test('the flattener refuses a limit that is not a positive integer', () => {
  assert.throws(() => flattenCatalog({}, { maxDepth: 0, maxKeys: 1 }), /maxDepth/u)
  assert.throws(() => flattenCatalog({}, { maxDepth: 1, maxKeys: 0 }), /maxKeys/u)
  assert.throws(() => flattenCatalog({}, { maxDepth: 1.5, maxKeys: 1 }), /maxDepth/u)
})
