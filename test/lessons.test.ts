import { describe, expect, test } from "bun:test"
import { commandFamily, countsAsRead, learnLevel, LESSONS, lessonFor, lessonKey, lessonView, placeLessons, type CommandFamily, type LessonPlacement } from "../src/app/lessons"
import { DEFAULT_PREFS, parseState, type Learning } from "../src/app/persist"
import { personState } from "../src/app/personState"
import { emptyRuntime } from "../src/app/store"
import type { StreamFrame } from "../src/host/types"
import { TOOL_KINDS, ToolPresentationSchema, type ToolPresentation } from "../src/protocol/schemas"
import { applyFrames, emptyTimeline, type TimelineItem, type ToolItem } from "../src/thread/reducer"
import { buildRows, type Row } from "../src/ui/thread/Timeline"

const shell = (command: string): ToolPresentation => ({ kind: "shell", title: `Run ${command}`, command })

describe("the lesson table", () => {
  const lessons = Object.entries(LESSONS)

  test("ids are unique and match their keys", () => {
    for (const [key, lesson] of lessons) expect(lesson.id).toBe(key)
    expect(new Set(lessons.map(([, lesson]) => lesson.id)).size).toBe(lessons.length)
  })

  test("text is short, plain ASCII with plain hyphens, full sentences, and balanced code marks", () => {
    for (const [, lesson] of lessons) {
      const limits: readonly (readonly [string | undefined, number])[] = [
        [lesson.title, 36],
        [lesson.body, 220],
        [lesson.fact, 180],
        [lesson.watch, 140],
      ]
      for (const [text, max] of limits) {
        if (text === undefined) continue
        expect([lesson.id, text.length <= max]).toEqual([lesson.id, true])
        expect([lesson.id, /^[\x20-\x7e]+$/.test(text)]).toEqual([lesson.id, true])
        expect([lesson.id, text.split("`").length % 2]).toEqual([lesson.id, 1])
        expect([lesson.id, text.includes("  ")]).toEqual([lesson.id, false])
      }
      for (const sentence of [lesson.body, lesson.fact, lesson.watch]) if (sentence !== undefined) expect([lesson.id, sentence.endsWith(".")]).toEqual([lesson.id, true])
      expect([lesson.id, lesson.title.endsWith(".")]).toEqual([lesson.id, false])
    }
  })

  test("every kind of call has a lesson, with or without a command", () => {
    for (const kind of TOOL_KINDS) {
      expect(LESSONS[lessonFor({ kind, title: kind }).id as keyof typeof LESSONS]).toBeDefined()
      expect(LESSONS[lessonFor({ kind, title: kind, command: "bun test" }).id as keyof typeof LESSONS]).toBeDefined()
    }
    expect(lessonFor({ kind: "shell", title: "Run it", command: "frobnicate --all" }).id).toBe("shell")
    expect(lessonFor({ kind: "verify", title: "Verify" }).id).toBe("verify")
    expect(lessonFor({ kind: "verify", title: "Verify", command: "bun run typecheck" }).id).toBe("typecheck")
    expect(lessonFor({ kind: "web", title: "Fetch", url: "https://bun.sh/docs" }).id).toBe("web-page")
    expect(lessonFor({ kind: "web", title: "Search", query: "zod 4 catch" }).id).toBe("web-search")
    expect(lessonFor({ kind: "search", title: "Search", query: "parseState" }).id).toBe("search")
  })
})

describe("what a command is", () => {
  // Every family, with the commands that must land in it.
  const EXAMPLES: Readonly<Record<CommandFamily, readonly string[]>> = {
    test: ["bun test", "npm test", "npm run test", "pnpm test:unit", "yarn test", "npx vitest run", "pytest -q", "python -m pytest", "go test ./...", "cargo test", "make test", "xcodebuild test -scheme App"],
    typecheck: ["tsc --noEmit", "bun run typecheck", "npm run type-check", "mypy src", "cargo check", "deno check main.ts"],
    lint: ["eslint .", "bun run lint", "pnpm lint", "ruff check --fix", "cargo clippy", "go vet ./..."],
    format: ["prettier --write .", "bun run format", "ruff format", "gofmt -w .", "cargo fmt"],
    build: ["bun run build", "npm run build", "vite build", "cargo build --release", "go build ./cmd/app", "bun build ./src/index.ts"],
    install: ["bun install", "npm ci", "npm i zod", "pnpm add -D vitest", "yarn", "pip install requests", "cargo add serde", "go mod tidy", "brew install jq"],
    "dev-server": ["bun run dev", "npm start", "pnpm dev", "vite", "next dev"],
    script: ["npm run release", "make", "just deploy-docs", "bun run generate"],
    "git-inspect": ["git status", "git diff --staged", "git log --oneline -5", "git -C ../app show HEAD", "git branch"],
    "git-commit": ["git add -A", "git commit -m 'Fix the parser'", "git reset HEAD file.ts", "git restore --staged a.ts"],
    "git-push": ["git push", "git push -u origin feat/office"],
    "git-rewrite": ["git reset --hard HEAD~1", "git rebase -i main", "git push --force", "git push --force-with-lease", "git clean -fd", "git checkout -- .", "git commit --amend --no-edit", "git restore src/a.ts"],
    "git-branch": ["git switch -c feat/x", "git checkout main", "git pull --rebase", "git merge main", "git stash"],
    github: ["gh pr create --fill", "gh run list"],
    search: ["rg parseState src", "grep -rn TODO .", "find . -name '*.ts'", "git grep parseState"],
    view: ["cat package.json", "head -n 20 README.md", "ls -la", "wc -l src/app/*.ts", "sed -n '1,40p' src/app/store.ts"],
    network: ["curl -s http://localhost:3000/health", "wget https://example.com/file"],
    delete: ["rm -rf dist", "rm old.ts", "rmdir tmp"],
    files: ["mv a.ts b.ts", "cp -r templates out", "mkdir -p src/office", "touch src/app/new.ts"],
    database: ["bun run migrate", "prisma migrate dev", "psql -c 'select 1'", "drizzle-kit push"],
  }

  test("each family's commands land in it", () => {
    for (const [family, commands] of Object.entries(EXAMPLES)) {
      for (const command of commands) expect([command, commandFamily(command)]).toEqual([command, family])
    }
  })

  test("words in arguments, echoes, and file names do not count", () => {
    expect(commandFamily("echo git push")).toBeUndefined()
    expect(commandFamily("cat test.log")).toBe("view")
    expect(commandFamily("grep -rn 'rm -rf' .")).toBe("search")
    expect(commandFamily("ls node_modules/.bin/jest")).toBe("view")
    expect(commandFamily("node scripts/build.js")).toBeUndefined()
    expect(commandFamily("npm publish")).toBeUndefined()
  })

  test("wrappers and folders are looked through", () => {
    expect(commandFamily("cd app && bun test")).toBe("test")
    expect(commandFamily("CI=1 FORCE_COLOR=0 npm test")).toBe("test")
    expect(commandFamily("sudo npm ci")).toBe("install")
    expect(commandFamily("./node_modules/.bin/eslint src")).toBe("lint")
    expect(commandFamily("bun test 2>&1 | tail -20")).toBe("test")
    expect(commandFamily("/bin/zsh -lc 'bun test | tail -3'")).toBe("test")
    expect(commandFamily("bash -c \"git push --force && echo done\"")).toBe("git-rewrite")
    expect(commandFamily("zsh -lc 'echo bun test'")).toBeUndefined()
  })

  test("in a chain, the step that is hardest to undo wins", () => {
    expect(commandFamily("bun run build && git push")).toBe("git-push")
    expect(commandFamily("rm -rf node_modules && bun install")).toBe("delete")
    expect(commandFamily("git push --force && rm -rf dist")).toBe("git-rewrite")
    expect(commandFamily("bun run typecheck && bun test")).toBe("typecheck")
  })

  test("the engine's intent names what the line alone does not, and a warning on the line still wins", () => {
    const nextest = shell("cargo nextest run")
    expect(lessonFor(nextest).id).toBe("shell")
    expect(lessonFor({ ...nextest, intent: "test" }).id).toBe("test")
    expect(lessonFor({ kind: "verify", title: "Verify", intent: "test" }).id).toBe("test")
    expect(lessonFor({ ...shell("gh pr create --fill"), intent: "pr" }).id).toBe("github")
    expect(lessonFor({ ...shell("git push --force origin main"), intent: "push" }).id).toBe("git-rewrite")
    expect(lessonFor({ ...shell("git commit --amend"), intent: "commit" }).id).toBe("git-rewrite")
  })

  test("an intent this desktop does not know is dropped, not the row", () => {
    const parsed = ToolPresentationSchema.parse({ kind: "shell", title: "Run deploy", command: "deploy", intent: "deploy" })
    expect(parsed).toMatchObject({ kind: "shell", command: "deploy" })
    expect(parsed.intent).toBeUndefined()
    expect(ToolPresentationSchema.parse({ kind: "verify", title: "Verify", intent: "test" }).intent).toBe("test")
  })
})

describe("levels", () => {
  const lesson = LESSONS.test

  test("Brief shows the title, Standard the body, Deep the fact and what to watch for", () => {
    expect(lessonView(lesson, "brief", false)).toEqual({ title: lesson.title, more: true })
    expect(lessonView(lesson, "standard", false)).toEqual({ title: lesson.title, body: lesson.body, more: true })
    expect(lessonView(lesson, "deep", false)).toEqual({ title: lesson.title, body: lesson.body, fact: lesson.fact, watch: lesson.watch, more: false })
  })

  test("opening a card shows the rest, and a lesson with nothing more has nothing to open", () => {
    expect(lessonView(lesson, "brief", true)).toEqual({ title: lesson.title, body: lesson.body, fact: lesson.fact, watch: lesson.watch, more: false })
    expect(lessonView(LESSONS.other, "standard", false).more).toBe(false)
  })

  test("a lesson is read when opened, or dismissed after three seconds in view", () => {
    expect(countsAsRead("open", 0)).toBe(true)
    expect(countsAsRead("dismiss", 2_999)).toBe(false)
    expect(countsAsRead("dismiss", 3_000)).toBe(true)
  })

  test("unset, learn mode is Standard while office mode is on and off otherwise; a choice sticks", () => {
    expect(learnLevel({ officeMode: "off" })).toBe("off")
    expect(learnLevel({ officeMode: "office" })).toBe("standard")
    expect(learnLevel({ officeMode: "list" })).toBe("standard")
    expect(learnLevel({ officeMode: "office", learn: "off" })).toBe("off")
    expect(learnLevel({ officeMode: "off", learn: "deep" })).toBe("deep")
  })
})

const tool = (key: string, presentation: ToolPresentation, turnId = "t2", extra: Partial<ToolItem> = {}): ToolItem => ({ kind: "tool", key, callId: key, turnId, name: presentation.kind, presentation, status: "ok", at: 1, ...extra })
const user = (key: string, turnId?: string): TimelineItem => ({ kind: "user", key, text: "go", state: "sent", attachments: 0, at: 0, ...(turnId === undefined ? {} : { turnId }) })
const read = (key: string, turnId?: string): ToolItem => tool(key, { kind: "read", title: `Read ${key}`, path: `${key}.ts` }, turnId)
const placement = (patch: Partial<LessonPlacement> = {}): LessonPlacement => ({ level: "standard", seen: new Set(), pinned: new Map(), ...patch })
const ids = (cards: ReadonlyMap<string, { readonly id: string }>): string[] => [...cards].map(([anchor, lesson]) => `${anchor}=${lesson.id}`)

describe("where cards go", () => {
  const items: TimelineItem[] = [user("u1", "t1"), tool("old", shell("bun test"), "t1"), user("u2", "t2"), read("r1"), tool("s1", shell("bun test")), read("r2"), tool("s2", shell("bun test --watch"))]

  test("beside the first call of each lesson in the latest turn only", () => {
    expect(ids(placeLessons(items, placement()))).toEqual(["r1=read", "s1=test"])
  })

  test("a lesson seen at this level is not offered again; at another level it is", () => {
    expect(ids(placeLessons(items, placement({ seen: new Set([lessonKey("standard", "test")]) })))).toEqual(["r1=read"])
    expect(ids(placeLessons(items, placement({ level: "deep", seen: new Set([lessonKey("standard", "test")]) })))).toEqual(["r1=read", "s1=test"])
  })

  test("a card seen this session stays where it was seen, even in an older turn", () => {
    const pinned = new Map([[lessonKey("standard", "test"), "old"]])
    expect(ids(placeLessons(items, placement({ seen: new Set([lessonKey("standard", "test")]), pinned })))).toEqual(["old=test", "r1=read"])
  })

  test("a card not yet seen keeps its place within its turn, and moves to a new turn", () => {
    const pinned = new Map([[lessonKey("standard", "read"), "r2"]])
    expect(ids(placeLessons(items, placement({ pinned })))).toEqual(["r2=read", "s1=test"])
    const next: TimelineItem[] = [...items, user("u3", "t3"), read("r3", "t3")]
    expect(ids(placeLessons(next, placement({ pinned })))).toEqual(["r3=read"])
  })

  test("a message waiting for its turn offers nothing new", () => {
    expect(ids(placeLessons([...items, user("u3")], placement()))).toEqual([])
  })

  test("subagent calls and plans get no card of their own", () => {
    const nested = [user("u", "t2"), tool("p", { kind: "plan", title: "Update plan" }), tool("child", shell("bun test"), "t2", { parentCallId: "a" })]
    expect(ids(placeLessons(nested, placement()))).toEqual([])
  })
})

describe("cards in the timeline", () => {
  const kinds = (rows: readonly Row[]): string[] => rows.map((row) => (row.type === "item" ? row.item.kind : row.type === "lesson" ? `lesson:${row.lesson.id}` : row.type))

  test("a card follows its call's row, and none is dropped when calls fold", () => {
    const items: TimelineItem[] = [user("u", "t2"), read("r1"), tool("w", { kind: "web", title: "Fetch", url: "https://bun.sh" }), tool("s1", shell("bun test"))]
    const rows = buildRows(items, false, false, false, "t2", placeLessons(items, placement()))
    expect(kinds(rows)).toEqual(["user", "tool", "lesson:read", "tool", "lesson:web-page", "tool", "lesson:test"])
  })

  test("a run carries one card, so a call with a second one starts the next run", () => {
    const items: TimelineItem[] = [user("u", "t2"), tool("q", { kind: "search", title: "Search", query: "x" }), read("r1"), tool("e", { kind: "edit", title: "Edit a.ts", path: "a.ts" }), read("r2")]
    expect(kinds(buildRows(items, false, false, false, "t2", placeLessons(items, placement())))).toEqual(["user", "tool", "lesson:search", "tool", "lesson:read", "steps", "lesson:edit"])
  })

  test("a call waiting on approval has its card under the approval", () => {
    const gate = tool("g", shell("git push"), "t2", { status: "running" })
    const approval: TimelineItem = { kind: "approval", key: "a1", approvalId: "a1", turnId: "t2", action: "git push", capability: "shell", status: "pending", callKey: "g", at: 2 }
    const items: TimelineItem[] = [user("u", "t2"), gate, approval]
    expect(kinds(buildRows(items, false, false, false, "t2", placeLessons(items, placement())))).toEqual(["user", "approval", "lesson:git-push"])
  })

  test("with learn mode off there are no cards", () => {
    const items: TimelineItem[] = [user("u", "t2"), tool("s1", shell("bun test"))]
    expect(kinds(buildRows(items, false, false, false, "t2"))).toEqual(["user", "tool"])
  })
})

describe("saved learning", () => {
  const saved = (learning: unknown, prefs: unknown = {}) => parseState({ version: 1, projects: [], threads: [], prefs, layout: {}, learning })

  test("keeps good entries, drops bad ones, and keeps the newest within bounds", () => {
    const read = [{ id: "test", level: "standard", at: 1 }, { id: "Bad Id", level: "standard", at: 2 }, { id: "lint", level: "loud", at: 3 }]
    expect(saved({ seen: ["standard:test", "standard:test", "nope", "deep:lint"], read }).learning).toEqual({ seen: ["standard:test", "deep:lint"], read: [{ id: "test", level: "standard", at: 1 }] } satisfies Learning)
    const many = Array.from({ length: 300 }, (_, index) => `brief:l${"a".repeat(index % 20)}`)
    expect(saved({ seen: many, read: [] }).learning.seen.length).toBeLessThanOrEqual(256)
    expect(saved("junk").learning).toEqual({ seen: [], read: [] })
    expect(saved(undefined).learning).toEqual({ seen: [], read: [] })
  })

  test("learn mode is unset unless chosen, and an unknown value falls back to unset", () => {
    expect(saved(undefined).prefs.learn).toBeUndefined()
    expect(saved(undefined, { learn: "deep" }).prefs.learn).toBe("deep")
    expect(saved(undefined, { learn: "loud" }).prefs.learn).toBeUndefined()
    expect(DEFAULT_PREFS.learn).toBeUndefined()
  })
})

describe("a person's lesson", () => {
  let seq = 0
  const event = (type: string, fields: Record<string, unknown>): StreamFrame => ({ kind: "event", data: { version: 1, sessionId: "s", seq: seq++, at: 1_000 + seq, type, ...fields } })
  const thread = { id: "t", projectId: "p", title: "T", titled: true, createdAt: 0, updatedAt: 0, backend: "native", mode: "agent", permission: "ask" } as const

  test("names the call it is running, or the one it asks about", () => {
    seq = 0
    const running = applyFrames(emptyTimeline(), [event("turn.started", { turnId: "t1", prompt: "go" }), event("tool.started", { turnId: "t1", callId: "c1", name: "shell", presentation: shell("bun test") })])
    expect(personState({ thread, runtime: { ...emptyRuntime(), engine: "ready", timeline: running }, backgroundAgents: 0 }).lesson).toBe("test")
    const asking = applyFrames(running, [event("approval.required", { turnId: "t1", approvalId: "a1", action: "git push", capability: "shell" })])
    expect(personState({ thread, runtime: { ...emptyRuntime(), engine: "ready", timeline: asking }, backgroundAgents: 0 })).toMatchObject({ pose: "raised", lesson: "test" })
  })
})
