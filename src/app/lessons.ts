import type { CommandIntent, ToolKind, ToolPresentation } from "../protocol/schemas"
import type { TimelineItem, ToolItem } from "../thread/reducer"
import type { LearnLevel, Prefs } from "./persist"
import { words } from "./platformWords"

/**
 * Learn mode: a fixed table of lessons written for Runrail, never generated, matched to a tool call
 * by its kind and, for a command, by what the command is. Brief shows a lesson's title, Standard
 * adds its body, and Deep adds a fact and what to watch for.
 */

export interface Lesson {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly fact?: string
  readonly watch?: string
}

export type LessonLevel = Exclude<LearnLevel, "off">

/** What a command is, judged from its words; anything unknown has no family. */
export type CommandFamily =
  | "test"
  | "typecheck"
  | "lint"
  | "format"
  | "build"
  | "install"
  | "dev-server"
  | "script"
  | "git-inspect"
  | "git-commit"
  | "git-push"
  | "git-rewrite"
  | "git-branch"
  | "github"
  | "search"
  | "view"
  | "network"
  | "delete"
  | "files"
  | "database"

type LessonId = CommandFamily | "shell" | "verify" | "read" | "write" | "edit" | "patch" | "list" | "web-page" | "web-search" | "agent" | "plan" | "mcp" | "other"

export const LESSONS: Readonly<Record<LessonId, Lesson>> = {
  test: {
    id: "test",
    title: "Running the tests",
    body: "The agent runs the project's tests to check that its change works and that nothing else broke. A failure is a clue: it should read the error, fix the cause, and run them again.",
    fact: "Test runners find tests by file name, such as `*.test.ts` or `test_*.py`, so a test in a file named any other way may never run.",
    watch: "Tests deleted, skipped, or loosened to get a pass, or success claimed without a run you can see.",
  },
  typecheck: {
    id: "typecheck",
    title: "Checking types",
    body: "A type checker such as `tsc` reads the whole program and reports values used in ways their types do not allow. It runs nothing, and it catches whole classes of bugs early.",
    fact: "`tsc --noEmit` checks types without writing any JavaScript, which is why projects use it as a check step.",
    watch: "Errors silenced with `any`, `@ts-ignore`, or casts instead of fixed.",
  },
  lint: {
    id: "lint",
    title: "Running the linter",
    body: "A linter reads the code and flags patterns that often hide bugs or break the project's conventions, such as unused variables or unsafe comparisons.",
    fact: "Many linters can fix some problems themselves, for example `eslint --fix` or `ruff check --fix`.",
    watch: "Rules switched off with disable comments instead of fixing the code.",
  },
  format: {
    id: "format",
    title: "Formatting the code",
    body: "A formatter rewrites spacing, line breaks, and quotes into one consistent style. It should not change what the code does, so a format-only diff is safe to skim.",
    fact: "Prettier deliberately has few options and gofmt has none, so style stops being a topic in review.",
    watch: "Formatting mixed into a real change, which buries the lines that matter.",
  },
  build: {
    id: "build",
    title: "Building the project",
    body: "A build turns source code into what actually ships, such as bundled JavaScript or a binary. A passing build shows the code compiles, not that it works.",
    fact: "A build can catch problems tests miss, such as an import that only fails in the production bundle.",
    watch: "Build output, like `dist` or `target` folders, showing up in the diff.",
  },
  install: {
    id: "install",
    title: "Installing packages",
    body: "Installing adds or updates the packages the project depends on and records their exact versions in a lockfile. Every new package is code you ship and trust.",
    fact: "`npm ci` installs exactly what the lockfile lists, and stops with an error if package.json and the lockfile disagree.",
    watch: "Packages you did not ask for, and lockfile changes much bigger than the task needs.",
  },
  "dev-server": {
    id: "dev-server",
    title: "Starting a dev server",
    body: "A dev server runs the app on your machine and reloads it as files change, so the agent can open it and check its work. It keeps running until it is stopped.",
    fact: "When a port is taken, dev servers like Vite and Next.js move to the next free one, so check the address they print.",
    watch: "Servers left running after the task, still holding a port.",
  },
  script: {
    id: "script",
    title: "Running a project script",
    body: "Projects give names to common commands, in the scripts section of package.json or in a Makefile. Running one runs whatever command the project put under that name.",
    fact: "`npm run` with no script name lists every script the project defines.",
    watch: "A script that does more than its name says; open the scripts file when in doubt.",
  },
  "git-inspect": {
    id: "git-inspect",
    title: "Reading git history",
    body: "Commands like `git status`, `git diff`, and `git log` only read the repository. The agent uses them to see what changed, and why, before touching anything.",
    fact: "`git diff` shows changes not yet staged, and `git diff --staged` shows what the next commit will contain.",
  },
  "git-commit": {
    id: "git-commit",
    title: "Committing changes",
    body: "A commit saves a snapshot of the staged changes with a message. It stays on this machine: nobody else sees it until it is pushed.",
    fact: "`git add -p` stages changes piece by piece, so one commit can hold just part of a file's edits.",
    watch: "Files swept in by `git add .` that do not belong, such as secrets, logs, or build output.",
  },
  "git-push": {
    id: "git-push",
    title: "Pushing to a remote",
    body: "Pushing sends local commits to a shared remote such as GitHub, where your team and CI see them. It is outward-facing, so it is a step worth approving yourself.",
    fact: "`git push` sends commits only; changes that are not committed stay on your machine.",
    watch: "Pushes straight to the main branch, and any push with `--force`.",
  },
  "git-rewrite": {
    id: "git-rewrite",
    title: "Rewriting or discarding history",
    body: "Commands like `git reset --hard`, `git rebase`, `git clean`, and `git push --force` rewrite history or throw changes away. Some of what they discard cannot be recovered.",
    fact: "`git push --force-with-lease` refuses to overwrite remote commits you have not fetched, unlike plain `--force`.",
    watch: "Uncommitted work lost to a reset or clean. These are good steps to keep behind your approval.",
  },
  "git-branch": {
    id: "git-branch",
    title: "Switching or syncing branches",
    body: "Commands like `git switch`, `git pull`, `git merge`, and `git stash` move between branches, bring in other people's work, or set changes aside. One command can change many files.",
    fact: "`git pull` is a fetch followed by a merge, or a rebase if the repository is set up that way.",
    watch: "Merge conflicts settled by keeping one side wholesale.",
  },
  github: {
    id: "github",
    title: "Using GitHub from the terminal",
    body: "The `gh` tool talks to GitHub: opening pull requests, reading issues, checking CI runs. Anything it creates or comments on there is visible to your team.",
    fact: "`gh pr create --fill` fills the pull request's title and body from the branch's commits.",
    watch: "Pull requests, issues, or comments created without your go-ahead.",
  },
  search: {
    id: "search",
    title: "Searching the code",
    body: "Searching finds every place a name or phrase appears, so a change can cover all of them. It is how an agent avoids fixing one call site and missing three others.",
    fact: "ripgrep (`rg`) skips files listed in .gitignore by default, which keeps results fast and relevant.",
    watch: "A rename or fix applied without first searching for other uses.",
  },
  view: {
    id: "view",
    title: "Looking at files",
    body: "Commands like `cat`, `head`, `tail`, `ls`, and `wc` print files or list folders. They change nothing; the agent is gathering context.",
    fact: "`tail -f` keeps printing new lines as a log file grows, which makes it handy for watching a running server.",
  },
  network: {
    id: "network",
    title: "Making a network request",
    body: "Tools like `curl` send requests to a server, for example to check an API the agent just changed. Depending on what it calls, a request can change data on that server.",
    fact: "`curl -i` prints the response's status line and headers along with the body.",
    watch: "Requests to production services, and requests that carry secrets or tokens.",
  },
  delete: {
    id: "delete",
    title: "Deleting files",
    // Read when shown, so it names the file manager of the platform Runrail runs on.
    get body() {
      return `\`rm\` removes files and folders right away. It does not use the Trash, so what it deletes cannot be restored from ${words().fileManager}.`
    },
    fact: "`rm -rf` deletes a folder and everything in it without asking. A wrong path or an empty variable can make it delete far more than intended.",
    watch: "Deletes outside the project folder, and `rm -rf` on a path built from a variable.",
  },
  files: {
    id: "files",
    title: "Moving and creating files",
    body: "Commands like `mv`, `cp`, `mkdir`, and `touch` move, copy, or create files and folders. They do not edit what is inside a file.",
    fact: "`mv` replaces a file already at the destination without asking, unless you pass `-i`.",
    watch: "Files moved out of the project, or overwritten by a copy.",
  },
  database: {
    id: "database",
    title: "Changing a database",
    body: "Migration tools change a database's structure, and query tools read or change its data. Reverting a commit does not undo a change made to a database.",
    fact: "Once a migration has run on a shared database, projects usually add a new migration to change it rather than edit the old one.",
    watch: "Commands pointed at production, and migrations that drop tables or columns.",
  },
  shell: {
    id: "shell",
    title: "Running a command",
    body: "The agent runs a command in your project and reads its output. A command can do anything you could do in a terminal, which is why some ask for your approval first.",
    fact: "Every command ends with an exit code: 0 means it worked, and anything else means it failed.",
    watch: "Commands you do not recognize. Open the row to see the full command and its output.",
  },
  verify: {
    id: "verify",
    title: "Running the project's checks",
    body: "The agent runs the checks this project has set up, such as tests or a type check, and the row records whether they passed.",
    fact: "Checks prove only what they cover: a passing run says nothing about behavior no check tests.",
    watch: "A turn that ends with checks failing, or never run at all.",
  },
  read: {
    id: "read",
    title: "Reading a file",
    body: "The agent opens a file to understand the code before changing it. Reading first means its edits fit the code that is actually there, not the code it expects.",
    fact: "Large files fill an agent's context quickly, so agents often read only the lines they need.",
    watch: "Edits to files the agent never read.",
  },
  write: {
    id: "write",
    title: "Writing a whole file",
    body: "The agent writes a file in one go: a new file, or a full replacement of an existing one. Review shows the result as a diff before you commit.",
    fact: "Rewriting a whole file can quietly drop parts nobody meant to change, which is why small edits are safer for existing files.",
    watch: "Existing files rewritten from scratch where a small edit would do.",
  },
  edit: {
    id: "edit",
    title: "Editing a file",
    body: "The agent changes specific lines in a file and leaves the rest alone. Each edit shows up in Review as a diff you can check before committing.",
    fact: "Small, focused diffs are easier to review and to revert than one large change.",
    watch: "Changes to files that have nothing to do with the task.",
  },
  patch: {
    id: "patch",
    title: "Applying a patch",
    body: "A patch describes changes as a diff: lines starting with - are removed and lines starting with + are added. Applying it can change several files in one step.",
    fact: "Each `@@` line in a patch says where its change starts, as line numbers in the old and new file.",
    watch: "A patch that touches more files than the task needs.",
  },
  list: {
    id: "list",
    title: "Looking through folders",
    body: "The agent lists a folder to see what is there before it reads or creates anything. It is how it finds its way around an unfamiliar project.",
    fact: "Folders such as `node_modules` and `.git` can hold thousands of files the agent has no reason to read.",
  },
  "web-page": {
    id: "web-page",
    title: "Reading a web page",
    body: "The agent fetches a page, such as documentation or an issue, to learn something the code cannot tell it.",
    fact: "A page can contain text aimed at the agent. A careful agent treats it as information, not as instructions to follow.",
    watch: "Anything the agent does because a web page told it to.",
  },
  "web-search": {
    id: "web-search",
    title: "Searching the web",
    body: "The agent searches the web for documentation, an error message, or an example, then reads what it finds.",
    fact: "Search results are often written for other versions; the docs for the version the project uses are the safest source.",
    watch: "Fixes copied from forums without checking they fit the project's versions.",
  },
  agent: {
    id: "agent",
    title: "Handing work to a subagent",
    body: "The agent starts a helper with a fresh context to take part of the job, such as a wide search or a check that can run alongside. The helper reports back a summary.",
    fact: "A subagent does not see the main conversation, so its work is only as good as the brief it is given.",
    watch: "Results from helpers accepted without a second look.",
  },
  plan: {
    id: "plan",
    title: "Making a plan",
    body: "The agent writes down the steps it intends to take and ticks them off as it goes. A plan makes a long task easy to follow, and easy to correct early.",
    fact: "Plans change as the agent learns more about the code; a revised plan is normal, not a mistake.",
    watch: "Steps marked done with no matching work in the timeline.",
  },
  mcp: {
    id: "mcp",
    title: "Using a connected tool",
    body: "MCP, the Model Context Protocol, lets the agent use tools from servers you have connected, such as a browser, an issue tracker, or a database.",
    fact: "An MCP server can do whatever its tools are built to do, with the access you give it, so connect only servers you trust.",
    watch: "Calls to a server you do not remember connecting.",
  },
  other: {
    id: "other",
    title: "Using a tool",
    body: "The agent is using a tool that has no lesson of its own here. Open the row to see exactly what it sent and what came back.",
  },
}

const KIND_LESSONS: Readonly<Record<Exclude<ToolKind, "shell" | "verify" | "web">, LessonId>> = {
  read: "read",
  write: "write",
  edit: "edit",
  patch: "patch",
  search: "search",
  list: "list",
  agent: "agent",
  plan: "plan",
  mcp: "mcp",
  other: "other",
}

const INTENT_LESSONS: Readonly<Record<CommandIntent, CommandFamily>> = {
  test: "test",
  build: "build",
  lint: "lint",
  typecheck: "typecheck",
  commit: "git-commit",
  push: "git-push",
  pr: "github",
}

export function lessonById(id: string | undefined): Lesson | undefined {
  return id !== undefined && Object.prototype.hasOwnProperty.call(LESSONS, id) ? LESSONS[id as LessonId] : undefined
}

export function lessonFor(presentation: ToolPresentation): Lesson {
  switch (presentation.kind) {
    case "shell":
    case "verify": {
      const family = presentation.command === undefined ? undefined : commandFamily(presentation.command)
      // The engine knows tools this table does not (`cargo nextest run`); a warning the line names outright still wins.
      const intent = presentation.intent === undefined ? undefined : INTENT_LESSONS[presentation.intent]
      const urgent = family !== undefined && URGENT.includes(family)
      return LESSONS[(urgent ? family : (intent ?? family)) ?? presentation.kind]
    }
    case "web":
      return LESSONS[presentation.url === undefined && presentation.query !== undefined ? "web-search" : "web-page"]
    default:
      return LESSONS[KIND_LESSONS[presentation.kind]]
  }
}

// ---------- Commands ----------

/** When a command chains steps, the one that is hardest to undo is the one worth explaining. */
const URGENT: readonly CommandFamily[] = ["git-rewrite", "delete", "git-push"]
const WRAPPERS = new Set(["sudo", "time", "env", "nice", "nohup", "command", "exec", "npx", "bunx", "uvx"])
const TWO_WORD_RUNNERS = new Set(["pnpm dlx", "pnpm exec", "yarn dlx", "npm exec", "bun x", "uv run", "poetry run", "pipenv run", "bundle exec"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** `/bin/zsh -lc '<script>'`, the way Codex runs every command. */
const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/

/** The family of a whole command line: the most urgent of its steps, else its first known one. */
export function commandFamily(command: string): CommandFamily | undefined {
  const line = command.trim()
  const families = (SHELL_WRAPPER.exec(line)?.[2] ?? line)
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segmentFamily(segment))
    .filter((family): family is CommandFamily => family !== undefined)
  return URGENT.find((family) => families.includes(family)) ?? families[0]
}

function segmentFamily(segment: string): CommandFamily | undefined {
  const words = segment.trim().replace(/^[(!]\s*/, "").split(/\s+/).filter((word) => word.length > 0)
  while (words.length > 0) {
    const first = words[0]!
    const pair = `${first} ${words[1] ?? ""}`
    if (ASSIGNMENT.test(first) || WRAPPERS.has(first)) words.shift()
    else if (TWO_WORD_RUNNERS.has(pair)) words.splice(0, 2)
    else break
  }
  const head = words[0]
  if (head === undefined) return undefined
  return classify(head.slice(head.lastIndexOf("/") + 1), words.slice(1))
}

function classify(head: string, args: readonly string[]): CommandFamily | undefined {
  const sub = args[0]
  switch (head) {
    case "git":
      return gitFamily(args)
    case "gh":
      return "github"
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "deno":
      return packageFamily(head, args)
    case "cargo":
      return sub === "test" ? "test" : sub === "build" || sub === "b" ? "build" : sub === "check" || sub === "c" ? "typecheck" : sub === "clippy" ? "lint" : sub === "fmt" ? "format" : sub === "add" || sub === "remove" || sub === "update" || sub === "install" ? "install" : undefined
    case "go":
      return sub === "test" ? "test" : sub === "build" ? "build" : sub === "vet" ? "lint" : sub === "fmt" ? "format" : sub === "get" || sub === "mod" ? "install" : undefined
    case "make":
    case "just":
      return scriptFamily(sub) ?? "script"
    case "python":
    case "python3":
      return sub === "-m" ? classify(args[1] ?? "", args.slice(2)) : undefined
    case "pip":
    case "pip3":
    case "uv":
    case "poetry":
    case "brew":
      return sub === "install" || sub === "uninstall" || sub === "add" || sub === "remove" || sub === "sync" || sub === "upgrade" ? "install" : undefined
    case "rg":
    case "grep":
    case "egrep":
    case "fgrep":
    case "ag":
    case "ack":
    case "fd":
    case "find":
      return "search"
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "wc":
    case "ls":
    case "tree":
    case "pwd":
    case "stat":
    case "file":
    case "bat":
      return "view"
    case "sed":
      return args.includes("-n") ? "view" : undefined
    case "curl":
    case "wget":
    case "http":
    case "xh":
      return "network"
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred":
      return "delete"
    case "mv":
    case "cp":
    case "mkdir":
    case "touch":
    case "ln":
    case "chmod":
    case "rsync":
      return "files"
    case "tsc":
    case "vue-tsc":
    case "mypy":
    case "pyright":
    case "svelte-check":
      return "typecheck"
    case "eslint":
    case "oxlint":
    case "golangci-lint":
    case "swiftlint":
    case "rubocop":
    case "stylelint":
    case "pylint":
    case "flake8":
    case "shellcheck":
      return "lint"
    case "ruff":
    case "biome":
      return sub === "format" ? "format" : "lint"
    case "prettier":
    case "black":
    case "gofmt":
    case "rustfmt":
    case "swiftformat":
    case "dprint":
      return "format"
    case "vitest":
    case "jest":
    case "pytest":
    case "mocha":
    case "ava":
    case "playwright":
    case "cypress":
    case "rspec":
    case "phpunit":
      return "test"
    case "vite":
      return sub === "build" ? "build" : sub === undefined || sub === "dev" || sub === "serve" || sub === "preview" ? "dev-server" : undefined
    case "next":
    case "nuxt":
    case "astro":
      return sub === "build" ? "build" : sub === "dev" || sub === "start" || sub === "preview" ? "dev-server" : undefined
    case "webpack":
    case "rollup":
    case "esbuild":
    case "tsup":
      return "build"
    case "xcodebuild":
      return args.includes("test") ? "test" : "build"
    case "swift":
      return sub === "test" ? "test" : sub === "build" ? "build" : undefined
    case "psql":
    case "mysql":
    case "sqlite3":
    case "mongosh":
    case "redis-cli":
    case "drizzle-kit":
    case "knex":
    case "alembic":
    case "dbmate":
    case "flyway":
      return "database"
    case "prisma":
      return sub === "migrate" || sub === "db" ? "database" : sub === "generate" ? "build" : undefined
    default:
      return undefined
  }
}

const INSTALL_WORDS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "upgrade", "up"])

function packageFamily(head: string, args: readonly string[]): CommandFamily | undefined {
  const sub = args[0]
  if (sub === undefined) return head === "yarn" ? "install" : undefined
  if (sub === "test" || sub === "t") return "test"
  if (INSTALL_WORDS.has(sub)) return "install"
  if (sub === "run" || sub === "run-script" || (head === "deno" && sub === "task")) return scriptFamily(args[1]) ?? "script"
  if (head === "deno") return sub === "check" ? "typecheck" : sub === "lint" ? "lint" : sub === "fmt" ? "format" : undefined
  if (head === "bun" && sub === "build") return "build"
  if (head === "npm") return sub === "start" ? "dev-server" : undefined
  // pnpm, yarn, and bun run a package.json script named directly, as in `pnpm lint`.
  return scriptFamily(sub)
}

function scriptFamily(name: string | undefined): CommandFamily | undefined {
  if (name === undefined) return undefined
  const base = name.toLowerCase()
  if (/^(test|tests|spec|e2e|unit|integration)([:-].*)?$/.test(base)) return "test"
  if (/^(typecheck|type-check|types|check-types|tsc)([:-].*)?$/.test(base)) return "typecheck"
  if (/^lint([:-].*)?$/.test(base)) return "lint"
  if (/^(format|fmt|prettier)([:-].*)?$/.test(base)) return "format"
  if (/^(build|compile|bundle)([:-].*)?$/.test(base)) return "build"
  if (/^(dev|start|serve|preview|watch)([:-].*)?$/.test(base)) return "dev-server"
  if (/^(migrate|migration|db)([:-].*)?$/.test(base)) return "database"
  return undefined
}

function gitFamily(args: readonly string[]): CommandFamily | undefined {
  let index = 0
  while (args[index] === "-C" || args[index] === "-c") index += 2
  const sub = args[index]
  const rest = args.slice(index + 1)
  switch (sub) {
    case "status":
    case "diff":
    case "log":
    case "show":
    case "blame":
    case "shortlog":
    case "describe":
    case "rev-parse":
    case "ls-files":
      return "git-inspect"
    case "grep":
      return "search"
    case "branch":
      return rest.some((arg) => /^(-[dDmM]|--delete|--move)$/.test(arg)) ? "git-branch" : "git-inspect"
    case "add":
    case "tag":
    case "revert":
      return "git-commit"
    case "commit":
      return rest.includes("--amend") ? "git-rewrite" : "git-commit"
    case "push":
      return rest.some((arg) => arg === "-f" || arg.startsWith("--force") || arg.startsWith("+")) ? "git-rewrite" : "git-push"
    case "reset":
      return rest.includes("--hard") ? "git-rewrite" : "git-commit"
    case "rebase":
    case "clean":
    case "filter-branch":
    case "filter-repo":
      return "git-rewrite"
    case "checkout":
      return rest.includes("--") || rest.includes(".") ? "git-rewrite" : "git-branch"
    case "restore":
      return rest.includes("--staged") && !rest.includes("--worktree") ? "git-commit" : "git-rewrite"
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? "git-rewrite" : "git-branch"
    case "switch":
    case "merge":
    case "pull":
    case "fetch":
    case "cherry-pick":
    case "worktree":
      return "git-branch"
    default:
      return undefined
  }
}

// ---------- Levels ----------

/** Learn mode as set, or, while unset, Standard when office mode is on and off otherwise. */
export function learnLevel(prefs: Pick<Prefs, "learn" | "officeMode">): LearnLevel {
  return prefs.learn ?? (prefs.officeMode === "off" ? "off" : "standard")
}

export function lessonKey(level: LessonLevel, id: string): string {
  return `${level}:${id}`
}

export interface LessonView {
  readonly title: string
  readonly body?: string
  readonly fact?: string
  readonly watch?: string
  /** Whether opening the card would show more. */
  readonly more: boolean
}

/** What a card shows at a level, closed or opened. */
export function lessonView(lesson: Lesson, level: LessonLevel, expanded: boolean): LessonView {
  const showBody = expanded || level !== "brief"
  const showExtras = expanded || level === "deep"
  const extras = lesson.fact !== undefined || lesson.watch !== undefined
  return {
    title: lesson.title,
    ...(showBody ? { body: lesson.body } : {}),
    ...(showExtras && lesson.fact !== undefined ? { fact: lesson.fact } : {}),
    ...(showExtras && lesson.watch !== undefined ? { watch: lesson.watch } : {}),
    more: !expanded && (level === "brief" || (level === "standard" && extras)),
  }
}

/** How long a card must stay in view before it counts as seen. */
export const LESSON_VIEW_MS = 3_000

/** A lesson counts as read when opened, or when dismissed after it was in view long enough. */
export function countsAsRead(action: "open" | "dismiss", inViewMs: number): boolean {
  return action === "open" || inViewMs >= LESSON_VIEW_MS
}

// ---------- Placement ----------

export interface LessonPlacement {
  readonly level: LessonLevel
  /** Lesson keys already seen at some point; they are not offered again. */
  readonly seen: ReadonlySet<string>
  /** Lesson key to the call its card showed beside this session. */
  readonly pinned: ReadonlyMap<string, string>
}

function topLevelTool(item: TimelineItem): item is ToolItem {
  return item.kind === "tool" && item.parentCallId === undefined && item.presentation.kind !== "plan"
}

/** The turn now running or last run; a message sent but not yet started has none, so nothing new is offered. */
function latestTurn(items: readonly TimelineItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined) continue
    if (item.kind === "user" && item.turnId === undefined) return undefined
    if ("turnId" in item && item.turnId !== undefined) return item.turnId
  }
  return undefined
}

/**
 * Which tool call gets which lesson card. A lesson not seen yet goes beside its first call in the
 * latest turn, so cards teach what is happening now and old turns stay quiet. A card that has shown
 * keeps its place: within its turn until it is seen, and anywhere once seen.
 */
export function placeLessons(items: readonly TimelineItem[], placement: LessonPlacement): ReadonlyMap<string, Lesson> {
  const cards = new Map<string, Lesson>()
  const prefix = `${placement.level}:`
  const turnOf = new Map<string, string | undefined>()
  for (const item of items) if (topLevelTool(item)) turnOf.set(item.key, item.turnId)
  const latest = latestTurn(items)
  for (const [key, anchor] of placement.pinned) {
    const lesson = key.startsWith(prefix) ? lessonById(key.slice(prefix.length)) : undefined
    if (lesson === undefined || !turnOf.has(anchor)) continue
    if (placement.seen.has(key) || (latest !== undefined && turnOf.get(anchor) === latest)) cards.set(anchor, lesson)
  }
  if (latest === undefined) return cards
  const placed = new Set([...cards.values()].map((lesson) => lesson.id))
  for (const item of items) {
    if (!topLevelTool(item) || item.turnId !== latest) continue
    const lesson = lessonFor(item.presentation)
    if (placed.has(lesson.id) || placement.seen.has(lessonKey(placement.level, lesson.id))) continue
    placed.add(lesson.id)
    cards.set(item.key, lesson)
  }
  return cards
}
