import { expect, test } from "bun:test"
import { mergeDiff } from "../src/app/diffRefresh"
import type { GitDiff, GitDiffFile } from "../src/protocol/schemas"

const file = (path: string, change = "modified", additions = 1, deletions = 0, extra: Partial<GitDiffFile> = {}): GitDiffFile => ({ path, change, additions, deletions, patch: `@@ -1 +1 @@\n+${path}\n`, ...extra })
const diff = (files: readonly GitDiffFile[], truncated = false): GitDiff => ({
  scope: "head",
  files: [...files],
  totals: { files: files.length, additions: files.reduce((sum, item) => sum + item.additions, 0), deletions: files.reduce((sum, item) => sum + item.deletions, 0) },
  truncated,
})

test("a stage re-reads only its files: each keeps its place, one that left the scope goes, totals follow", () => {
  const current = diff([file("a.ts"), file("b.ts", "modified", 4, 2), file("c.ts")])
  const merged = mergeDiff(current, ["b.ts", "c.ts"], diff([file("b.ts", "modified", 9, 1)]))
  expect(merged?.files.map((item) => item.path)).toEqual(["a.ts", "b.ts"])
  expect(merged?.files[1]?.additions).toBe(9)
  expect(merged?.totals).toEqual({ files: 2, additions: 10, deletions: 1 })
})

test("a file new to the scope lands in path order", () => {
  const merged = mergeDiff(diff([file("a.ts"), file("c.ts")]), ["b.ts"], diff([file("b.ts")]))
  expect(merged?.files.map((item) => item.path)).toEqual(["a.ts", "b.ts", "c.ts"])
})

test("a partial read that cannot stand in for a whole one asks for the whole one", () => {
  // A list cut short may hide where the file belongs.
  expect(mergeDiff(diff([file("a.ts")], true), ["a.ts"], diff([file("a.ts")]))).toBeUndefined()
  expect(mergeDiff(diff([file("a.ts")]), ["a.ts"], diff([file("a.ts")], true))).toBeUndefined()
  // A rename spans two paths; reading one shows the wrong change.
  expect(mergeDiff(diff([file("new.ts", "renamed", 1, 0, { originalPath: "old.ts" })]), ["new.ts"], diff([file("new.ts", "added")]))).toBeUndefined()
  expect(mergeDiff(diff([file("old.ts", "deleted"), file("new.ts", "untracked")]), ["new.ts"], diff([file("new.ts", "renamed", 1, 0, { originalPath: "old.ts" })]))).toBeUndefined()
  // A new file staged beside a deleted one may now pair with it as a rename.
  expect(mergeDiff(diff([file("old.ts", "deleted"), file("new.ts", "untracked")]), ["new.ts"], diff([file("new.ts", "added")]))).toBeUndefined()
  expect(mergeDiff(diff([file("old.ts", "deleted"), file("new.ts", "untracked")]), ["old.ts"], diff([file("old.ts", "deleted")]))).toBeUndefined()
  // An answer about a path that was not asked for.
  expect(mergeDiff(diff([file("a.ts")]), ["a.ts"], diff([file("a.ts"), file("z.ts")]))).toBeUndefined()
})

test("a discarded new file drops out without a whole read when nothing could pair with it", () => {
  const merged = mergeDiff(diff([file("a.ts"), file("scratch.ts", "untracked", 5)]), ["scratch.ts"], diff([]))
  expect(merged?.files.map((item) => item.path)).toEqual(["a.ts"])
  expect(merged?.totals.additions).toBe(1)
})

test("a patch's shape counts its lines and hunks, and sizes a hidden large diff as its note", async () => {
  const { patchHeight, patchShape } = await import("../src/ui/diff/DiffView")
  expect(patchShape(undefined)).toEqual({ lines: 0, hunks: 0 })
  expect(patchShape("@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n c")).toEqual({ lines: 4, hunks: 2 })
  const big = { lines: 5_000, hunks: 1 }
  expect(patchHeight(big)).toBeLessThan(100)
  expect(patchHeight(big, true)).toBeGreaterThan(50_000)
  expect(patchHeight({ lines: 10, hunks: 1 })).toBeGreaterThan(patchHeight({ lines: 2, hunks: 1 }))
})

test("a pinned row stays mounted when it scrolls out of view, in index order", async () => {
  const { keepMounted } = await import("../src/ui/virtual")
  const range = { startIndex: 10, endIndex: 12, overscan: 1, count: 40 }
  expect(keepMounted(undefined)(range)).toEqual([9, 10, 11, 12, 13])
  expect(keepMounted(2)(range)).toEqual([2, 9, 10, 11, 12, 13])
  expect(keepMounted(11)(range)).toEqual([9, 10, 11, 12, 13])
  expect(keepMounted(-1)(range)).toEqual([9, 10, 11, 12, 13])
  expect(keepMounted(40)(range)).toEqual([9, 10, 11, 12, 13])
})

test("the file tree shows a folder's children only while it is open", async () => {
  const { treeRows } = await import("../src/ui/inspector/FilesPane")
  const leaf = (path: string) => ({ name: path.slice(path.lastIndexOf("/") + 1), path, type: "file" as const, children: [] })
  const tree = [{ name: "src", path: "src", type: "directory" as const, children: [{ name: "lib", path: "src/lib", type: "directory" as const, children: [leaf("src/lib/a.ts")] }, leaf("src/b.ts")] }, leaf("README.md")]
  const shown = (open: string[]) => treeRows(tree, new Set(open)).map((row) => `${String(row.depth)}:${row.node.path}`)
  expect(shown([])).toEqual(["0:src", "0:README.md"])
  expect(shown(["src"])).toEqual(["0:src", "1:src/lib", "1:src/b.ts", "0:README.md"])
  expect(shown(["src", "src/lib"])).toEqual(["0:src", "1:src/lib", "2:src/lib/a.ts", "1:src/b.ts", "0:README.md"])
  // An open folder inside a closed one stays hidden.
  expect(shown(["src/lib"])).toEqual(["0:src", "0:README.md"])
})
