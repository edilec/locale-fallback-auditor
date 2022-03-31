/**
 * The fallback graph.
 *
 * Each locale declares an ordered list of locales to fall back to. Resolution
 * is a depth-first pre-order walk of that list, which is what gives a regional
 * locale its predictable order: `pt-BR` resolves `pt-BR`, then `pt`, then `en`.
 *
 * The walk carries a visited set and a path set. The visited set makes the walk
 * terminate no matter what the graph looks like; the path set is what turns a
 * back edge into a reported `fallback-cycle` instead of a silent stop. A cycle
 * does not make resolution unknown -- everything reachable is still visited in
 * a defined order -- so it is reported as a defect in the configuration, not as
 * missing evidence.
 *
 * BCP 47 tags are case insensitive, so edges are matched on the ASCII
 * lowercased id. The declared spelling is what reaches the report.
 */

import { byCodeUnit } from './rules.mjs'

/**
 * Locale ids are validated as ASCII before they get here, so `toLowerCase`
 * cannot depend on a host locale.
 */
export function localeKey(id) {
  return String(id).toLowerCase()
}

/** Ids and edge indices are ASCII-safe, so this separator cannot collide. */
const PAIR_SEPARATOR = '|'

/**
 * Build the adjacency map. `locales` is the validated list of
 * `{ id, index, fallback }` records; the caller has already rejected duplicate
 * ids, so one key per locale is guaranteed.
 */
export function buildGraph(locales) {
  const graph = new Map()
  for (const locale of locales) {
    graph.set(localeKey(locale.id), {
      id: locale.id,
      index: locale.index,
      edges: locale.fallback.map((target) => ({ raw: target, key: localeKey(target) })),
    })
  }
  return graph
}

/**
 * Resolve one locale's fallback order.
 *
 * Returns the visited order (always starting with the locale itself), the
 * cycles found on the way, the edges whose target is not a declared locale, the
 * edges that changed nothing, and any edge that would have exceeded `maxDepth`.
 */
export function resolutionOrder(startKey, graph, maxDepth) {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error('maxDepth must be a positive integer')
  const node = graph.get(startKey)
  if (node === undefined) throw new Error('Unknown locale key')

  const order = [startKey]
  const visited = new Set([startKey])
  const path = [startKey]
  const pathSet = new Set([startKey])
  const cycles = []
  const unknown = []
  const redundant = []
  const depthExceeded = []

  const stack = [{ key: startKey, edges: node.edges, next: 0, depth: 1 }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.next >= frame.edges.length) {
      stack.pop()
      pathSet.delete(frame.key)
      path.pop()
      continue
    }
    const edge = frame.edges[frame.next]
    const edgeIndex = frame.next
    frame.next += 1

    if (!graph.has(edge.key)) {
      unknown.push({ fromKey: frame.key, edgeIndex, target: edge.raw })
      continue
    }
    if (pathSet.has(edge.key)) {
      cycles.push([...path, edge.key])
      continue
    }
    if (visited.has(edge.key)) {
      // The target was already reached through an earlier edge, so this one
      // never changes what resolution does. Only the starting locale's own
      // edges are reported: redundancy deeper in the graph depends on where
      // the walk began and is not a property of the declaration.
      if (frame.key === startKey) redundant.push({ fromKey: frame.key, edgeIndex, target: edge.key })
      continue
    }
    if (frame.depth + 1 > maxDepth) {
      depthExceeded.push({ fromKey: frame.key, edgeIndex, target: edge.key, depth: frame.depth + 1 })
      continue
    }
    visited.add(edge.key)
    order.push(edge.key)
    path.push(edge.key)
    pathSet.add(edge.key)
    stack.push({ key: edge.key, edges: graph.get(edge.key).edges, next: 0, depth: frame.depth + 1 })
  }

  return { order, cycles, unknown, redundant, depthExceeded }
}

/**
 * A cycle is the same cycle whichever member you enter it from, so it is keyed
 * by its rotation starting at the code-unit smallest member. Without this the
 * same two-locale loop would be reported once per locale that can reach it.
 */
export function cycleKey(path) {
  const start = path.indexOf(path[path.length - 1])
  const ring = path.slice(start, path.length - 1)
  let pivot = 0
  for (let index = 1; index < ring.length; index += 1) {
    if (byCodeUnit(ring[index], ring[pivot]) < 0) pivot = index
  }
  return [...ring.slice(pivot), ...ring.slice(0, pivot)].join(' -> ')
}

/**
 * Analyse the whole graph once: per-locale resolution orders plus the
 * deduplicated set of graph defects. Every list is in code unit order so the
 * result does not depend on Map iteration order.
 */
export function analyzeGraph(graph, { maxDepth }) {
  const orders = new Map()
  const cycles = new Map()
  const unknown = new Map()
  const redundant = new Map()
  const depthExceeded = new Map()
  // Locales whose own resolution walk hit an undeclared target or the depth
  // limit. Keys they do not own have no known answer, and the audit must say
  // so instead of reporting the next catalog it happens to find.
  const truncated = new Set()

  const keys = [...graph.keys()].sort(byCodeUnit)
  for (const key of keys) {
    const result = resolutionOrder(key, graph, maxDepth)
    orders.set(key, result.order)
    if (result.unknown.length > 0 || result.depthExceeded.length > 0) truncated.add(key)
    for (const path of result.cycles) {
      const id = cycleKey(path)
      if (!cycles.has(id)) {
        const start = path.indexOf(path[path.length - 1])
        cycles.set(id, { key: id, members: path.slice(start).map((member) => graph.get(member).id) })
      }
    }
    for (const entry of result.unknown) {
      const id = `${entry.fromKey}${PAIR_SEPARATOR}${entry.edgeIndex}`
      if (!unknown.has(id)) unknown.set(id, entry)
    }
    for (const entry of result.redundant) {
      const id = `${entry.fromKey}${PAIR_SEPARATOR}${entry.edgeIndex}`
      if (!redundant.has(id)) redundant.set(id, entry)
    }
    for (const entry of result.depthExceeded) {
      const id = `${key}${PAIR_SEPARATOR}${entry.fromKey}${PAIR_SEPARATOR}${entry.edgeIndex}`
      if (!depthExceeded.has(id)) depthExceeded.set(id, { ...entry, startKey: key })
    }
  }

  const sortByKey = (map) => [...map.entries()].sort((a, b) => byCodeUnit(a[0], b[0])).map((entry) => entry[1])
  return {
    orders,
    truncated,
    cycles: sortByKey(cycles),
    unknown: sortByKey(unknown),
    redundant: sortByKey(redundant),
    depthExceeded: sortByKey(depthExceeded),
  }
}
