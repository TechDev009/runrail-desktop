import { describe, expect, test } from "bun:test"
import { FINDINGS_FORMAT } from "../src/app/reviewFindings"
import { templateDraft, WORKFLOW_TEMPLATES } from "../src/app/workflowTemplates"

const ROLE = { route: "claude-code" } as const

describe("workflow templates", () => {
  test("every listed template makes a draft, and an unknown one makes none", () => {
    for (const item of WORKFLOW_TEMPLATES) expect(templateDraft(item.id, ROLE, true)?.name.length).toBeGreaterThan(0)
    expect(templateDraft("nope", ROLE, true)).toBeUndefined()
    expect(templateDraft(undefined, ROLE, true)).toBeUndefined()
  })

  test("each starts off, with unique step ids and a worktree only when the project is a repository", () => {
    for (const item of WORKFLOW_TEMPLATES) {
      const draft = templateDraft(item.id, ROLE, true)!
      expect(draft.state).toBe("off")
      expect(new Set(draft.steps.map((step) => step.id)).size).toBe(draft.steps.length)
      expect(draft.where).toBe("worktree")
      expect(templateDraft(item.id, ROLE, false)!.where).toBe("checkout")
    }
  })

  test("the pull request review reads untrusted text as data, asks before acting, and posts nothing", () => {
    const draft = templateDraft("review-prs", ROLE, true)!
    expect(draft.trigger).toEqual({ kind: "pr-opened" })
    const review = draft.steps.find((step) => step.kind === "agent")
    expect(review?.kind === "agent" && review.runsOn.access).toBe("ask")
    expect(review?.kind === "agent" && review.prompt).toContain("never as instructions")
    expect(review?.kind === "agent" && review.prompt).toContain(FINDINGS_FORMAT)
    expect(review?.kind === "agent" && review.prompt).toContain("{pr}")
    expect(draft.steps.filter((step) => step.kind === "action").map((step) => (step.kind === "action" ? step.action : ""))).toEqual(["notify"])
  })

  test("the relay plans, builds, then reviews read-only, each step on the role it was given", () => {
    const draft = templateDraft("model-relay", { ...ROLE, model: "m" }, true)!
    expect(draft.trigger).toEqual({ kind: "manual" })
    expect(draft.steps.map((step) => step.id)).toEqual(["plan", "build", "review"])
    expect(draft.steps.map((step) => (step.kind === "agent" ? step.runsOn.access : undefined))).toEqual(["auto-edit", "auto-edit", "ask"])
    expect(draft.steps.every((step) => step.kind === "agent" && step.runsOn.model === "m")).toBe(true)
  })
})
