import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ToolItem } from "../src/thread/reducer"
import { StepsGroup } from "../src/ui/thread/rows"

const call = (key: string, presentation: Record<string, unknown>, fields: Partial<ToolItem> = {}): ToolItem =>
  ({ kind: "tool", key, callId: key, turnId: "t1", name: "run_command", presentation, status: "ok", at: 1_000, endedAt: 2_000, ...fields }) as ToolItem

const render = (items: readonly ToolItem[], open = false): string => renderToStaticMarkup(<StepsGroup items={items} approved={new Set()} open={open} onToggle={() => undefined} />)

describe("a folded run of calls", () => {
  const items = [
    call("a", { kind: "shell", title: "Run bun run typecheck", command: "bun run typecheck", intent: "typecheck" }),
    call("b", { kind: "shell", title: "Run bun test", command: "bun test", intent: "test" }, { status: "failed" }),
    call("c", { kind: "edit", title: "Edit src/a.ts", path: "src/a.ts", additions: 4, deletions: 2 }),
    call("d", { kind: "shell", title: "Run bun test", command: "bun test", intent: "test" }),
    call("e", { kind: "shell", title: "Run ls missing", command: "ls missing" }, { status: "failed" }),
  ]

  test("says what it did and how its checks ended, and stays closed", () => {
    const html = render(items)
    expect(html).toContain("Ran 4 commands, edited 1 file")
    expect(html).toContain('<span class="add">+4</span>')
    expect(html).toContain('<span class="steps-outcome is-ok">types passed</span>')
    expect(html).toContain('<span class="steps-outcome is-ok">tests passed</span>')
    expect(html).toContain('<span class="steps-outcome is-failed">1 failed</span>')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain("steps-items")
  })

  test("while a call runs, it names that call", () => {
    const html = render([items[0]!, call("f", { kind: "shell", title: "Run bun run build", command: "bun run build", intent: "build" }, { status: "running", endedAt: undefined })])
    expect(html).toContain("Running bun run build")
    expect(html).toContain("2 steps")
    expect(html).not.toContain("build passed")
  })

  test("opens to each call's own row", () => {
    const html = render(items, true)
    expect(html).toContain("steps-items")
    expect(html.match(/class="row-tool/g)?.length).toBe(5)
  })
})
