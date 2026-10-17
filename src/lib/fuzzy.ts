/**
 * Small subsequence matcher for pickers. Higher is better; -1 means no match. Consecutive runs,
 * word starts, and basename hits score higher, so "sess" ranks src/session.ts above
 * src/transcript/sessions/index.ts.
 */
export function fuzzyScore(query: string, text: string): number {
  if (query.length === 0) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) {
    const slash = t.lastIndexOf("/")
    const boundary = direct === 0 || /[\s/_.-]/.test(t[direct - 1] ?? "")
    return 1_000 - direct + (direct > slash ? 400 : 0) + (boundary ? 200 : 0) - t.length
  }
  let score = 0
  let position = 0
  let run = 0
  for (const char of q) {
    const found = t.indexOf(char, position)
    if (found < 0) return -1
    run = found === position ? run + 1 : 0
    score += 10 + run * 5 - Math.min(found - position, 10)
    position = found + 1
  }
  return score - t.length
}

export function rank<T>(query: string, items: readonly T[], text: (item: T) => string, limit = 50): T[] {
  if (query.length === 0) return items.slice(0, limit)
  const scored: { readonly item: T; readonly score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(query, text(item))
    if (score >= 0) scored.push({ item, score })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, limit).map((entry) => entry.item)
}
