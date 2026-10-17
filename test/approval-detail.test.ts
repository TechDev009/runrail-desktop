import { describe, expect, test } from "bun:test"
import { APPROVAL_SETTLE_MS } from "../src/app/attention"
import { isQuestion } from "../src/thread/reducer"
import { approvalDetail, approvalQuestion, approvalReasonLine, approvalShortcut, reasonParts, visibleText, type ApprovalKeyPress, type ApprovalKeyTarget } from "../src/ui/thread/rows"

test("an approval shows the command it asks about, not the word for its kind", () => {
  const asked = { action: "command", reason: "Bash: cd /work && npm test" }
  expect(reasonParts(asked.reason)).toEqual({ tool: "Bash", detail: "cd /work && npm test" })
  expect(approvalDetail(asked, undefined)).toBe("cd /work && npm test")
  expect(approvalReasonLine(asked, approvalDetail(asked, undefined))).toBeUndefined()
  // An action that names what it does is shown as it is, and the reason stays beside it.
  expect(approvalDetail({ action: "git push origin main", reason: "Publishes the branch" }, undefined)).toBe("git push origin main")
  expect(approvalReasonLine({ action: "git push origin main", reason: "Publishes the branch" }, "git push origin main")).toBe("Publishes the branch")
  // Nothing to show beyond the call row: no detail, the reason as it came.
  expect(approvalDetail({ action: "Bash", reason: "Leave plan mode and start making changes" }, { name: "Bash" })).toBeUndefined()
  expect(approvalDetail({ action: "plan" }, undefined)).toBeUndefined()
})

test("mod+Enter answers the thread's approval only from the thread, never from another field or a held key", () => {
  const element = (tagName: string, inside: readonly string[] = []): ApprovalKeyTarget => ({ tagName, closest: (selector) => (inside.includes(selector) ? {} : null) })
  const press = (target: ApprovalKeyTarget | null, mods: Partial<ApprovalKeyPress> = {}): ApprovalKeyPress => ({ key: "Enter", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, target, ...mods })
  const settled = APPROVAL_SETTLE_MS
  expect(approvalShortcut(press(element("BODY")), settled)).toBe("approve")
  expect(approvalShortcut(press(element("BODY"), { shiftKey: true }), settled)).toBe("deny")
  expect(approvalShortcut(press(element("BUTTON")), settled)).toBe("approve")
  // The composer passes the keys on only when it has nothing to send.
  expect(approvalShortcut(press(element("TEXTAREA", [".composer-dock"])), settled)).toBe("approve")
  // A review note, the file filter, a commit message: the key is theirs.
  expect(approvalShortcut(press(element("TEXTAREA")), settled)).toBeUndefined()
  expect(approvalShortcut(press(element("input")), settled)).toBeUndefined()
  expect(approvalShortcut(press({ tagName: "DIV", isContentEditable: true, closest: () => null }), settled)).toBeUndefined()
  expect(approvalShortcut(press(element("BODY"), { repeat: true }), settled)).toBeUndefined()
  expect(approvalShortcut(press(element("BODY"), { defaultPrevented: true }), settled)).toBeUndefined()
  expect(approvalShortcut(press(element("BODY")), settled - 1)).toBeUndefined()
  expect(approvalShortcut(press(element("BODY"), { metaKey: false }), settled)).toBeUndefined()
})

test("an approval writes out characters that hide or reorder text", () => {
  // U+202E makes "rm -rf ~/sdlrow" render as a harmless-looking name.
  expect(approvalDetail({ action: "command", reason: "Bash: echo \u202Ehs.lacol | rm -rf ~" }, undefined)).toBe("echo \\u{202E}hs.lacol | rm -rf ~")
  expect(approvalDetail({ action: "curl x\u200B.sh", reason: undefined }, undefined)).toBe("curl x\\u{200B}.sh")
  expect(approvalReasonLine({ action: "ls", reason: "Lists\u2066 files" }, "ls")).toBe("Lists\\u{2066} files")
  expect(visibleText("line one\nline\ttwo")).toBe("line one\nline\ttwo")
})

describe("a coding tool's question", () => {
  test("is a question with its choices or without them, and never only an approval", () => {
    expect(isQuestion({ action: "question", capability: "user.input", questions: [{ id: "q1", question: "Which?", options: [] }] })).toBe(true)
    expect(isQuestion({ action: "question", capability: "user.input" })).toBe(true)
    expect(isQuestion({ action: "Allow Computer Use to use \"Runrail\"?", capability: "user.input" })).toBe(false)
    expect(isQuestion({ action: "command", capability: "process.exec" })).toBe(false)
  })

  test("whose choices did not arrive shows what it asks, not an approval of the word question", () => {
    const item = { action: "question", capability: "user.input", reason: "Deploy where?" }
    expect(approvalDetail(item, undefined)).toBeUndefined()
    expect(approvalReasonLine(item, undefined)).toBeUndefined()
    expect(approvalQuestion({ kind: "approval", key: "k", approvalId: "a", status: "pending", at: 0, ...item })).toBe("Deploy where?")
  })
})
