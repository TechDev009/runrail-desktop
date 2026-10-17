import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import type { PersonState, PersonTone, Pose } from "../src/app/personState"
import { PersonCard } from "../src/ui/office/Person"

const OFFICE = readFileSync(join(import.meta.dir, "..", "src", "styles", "office.css"), "utf8")
const tag = { title: "Rebuild the docs search on the prebuilt index so it stops timing out", unread: false, model: "Opus 5.5", worktree: false, pinned: false, background: 0 }

function card(pose: Pose, tone: PersonTone, label: string): string {
  const person: PersonState = { pose, label, tone, moving: false, helpers: 0 }
  return renderToStaticMarkup(<PersonCard threadId="t" project="website" now={0} selected={false} filter="all" focusable onOpen={() => undefined} onKeyDown={() => undefined} person={person} tag={tag} />)
}

function bubble(html: string): string {
  return /class="person-bubble"[^>]*>(.*?)<\/span>/.exec(html)?.[1] ?? ""
}

describe("people on the floor", () => {
  test("the bubble over a head is one glyph for how the thread stands", () => {
    expect(bubble(card("typing", "work", "Editing"))).toBe("···")
    expect(bubble(card("raised", "ask", "Needs you"))).toBe("?")
    expect(bubble(card("quiet", "ask", "Quiet"))).toBe("z")
    expect(bubble(card("failed", "fail", "Failed"))).toBe("!")
    expect(bubble(card("done", "done", "Done"))).toContain("<svg")
    expect(bubble(card("idle", "idle", "Idle"))).toBe("z")
  })

  test("the name plate keeps two lines and the tooltip has the whole title", () => {
    const html = card("idle", "idle", "Idle")
    expect(html).toContain(`title="${tag.title}\nIdle"`)
    const name = /\.person-name \{([^}]*)\}/.exec(OFFICE)?.[1] ?? ""
    expect(name).toContain("-webkit-line-clamp: 2;")
    expect(name).toContain("min-height: 2.6em;")
  })

  test("only working and needs-you people move, and only on the floor's clock, which reduced motion stops", () => {
    // Every pose that moves waits on a room's beat; the beats are the only thing that changes a person.
    const beats = OFFICE.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .flatMap((rule) => (rule.split("{")[0] ?? "").split(","))
      .map((selector) => selector.trim())
      .filter((selector) => /^\.room\[data-[abc]="1"\]/.test(selector) && selector.includes(".person"))
    expect(beats.length).toBeGreaterThan(5)
    for (const selectors of beats) {
      const poses = [...selectors.matchAll(/data-pose="([a-z]+)"|\.person\.is-([a-z]+)/g)].map((match) => match[1] ?? match[2])
      for (const pose of poses) expect(["typing", "reading", "browsing", "running", "thinking", "delegating", "raised", "work"]).toContain(pose)
    }
    // The floor's clock runs only while the window shows, the room is in view, and motion is not reduced.
    const office = readFileSync(join(import.meta.dir, "..", "src", "ui", "office", "Office.tsx"), "utf8")
    expect(office).toContain("moving={!hidden && !still}")
    expect(office).toContain("if (element === null || offscreen || !moving) return")
    // No CSS animation runs on people. The Peek card's opening is the one other than the weather's (palette-scenes.test.tsx), and reduced motion turns it off.
    expect(OFFICE.match(/animation: [a-z-]+ /g)).toEqual(["animation: peek-in "])
    expect(OFFICE).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.peek-card \{\s*animation: none;/)
  })
})
