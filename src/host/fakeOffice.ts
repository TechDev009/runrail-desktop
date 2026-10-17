import type { PreviewScenario } from "./fakeConnections"

/**
 * `?preview=office`: four projects and twelve threads that fill themselves with mixed activity, so
 * office mode and the waiting tray can be built and shown without a click. Three turns stop for an
 * approval, one fails, one goes silent, two keep working, and one hands work to subagents.
 * `office,stress` loads six projects and forty threads, twelve of them working at once.
 */

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** One change a turn makes to a file. */
interface Edit {
  readonly path: string
  readonly oldText: string
  readonly newText: string
}

/** What a scripted turn works on. */
interface Task {
  /** Files it reads. */
  readonly files: readonly string[]
  /** What it searches the code for. */
  readonly searches: readonly string[]
  /** Its changes; a long turn goes round them again. */
  readonly edits: readonly Edit[]
  /** The test file it writes and runs, and the tests in it. */
  readonly test: string
  readonly tests: readonly string[]
  readonly plan: readonly string[]
  /** What a delegating turn hands to subagents. */
  readonly agents?: readonly string[]
}

interface Turn {
  /** What the person asks; it opens the thread's timeline. */
  readonly prompt: string
  /** When the prompt is sent, counted from load. */
  readonly startAfterMs: number
}

/** Starts a long shell command, then sends nothing at all until it is stopped. */
interface QuietScript extends Turn {
  readonly role: "quiet"
}

/** Explores, edits, and asks to run the tests. */
interface ApprovalScript extends Turn {
  readonly role: "approval"
  readonly task: Task
}

/** Edits, runs the tests, and the turn fails on them. */
interface FailScript extends Turn {
  readonly role: "fail"
  readonly task: Task
  /** What the failing test run prints. */
  readonly output: string
}

/** Works, handing parts to subagents when delegating, until `durationMs` is up, then finishes. */
interface LongScript extends Turn {
  readonly role: "work" | "delegate"
  readonly task: Task
  readonly durationMs: number
}

/** A scripted thread's first turn. */
export type OfficeScript = QuietScript | ApprovalScript | FailScript | LongScript
export type OfficeRole = OfficeScript["role"]

/** A task with the title and prompt of the thread that runs it. */
interface Job {
  readonly title: string
  readonly prompt: string
  readonly task: Task
}

const ENGINE_RETRY: Job = {
  title: "Retry engine start when the control socket is slow",
  prompt: "On a cold boot the engine sometimes fails to start because the control socket is not listening yet. Retry the connection a few times with backoff, and add a test for a slow socket.",
  task: {
    files: ["src/engine/start.ts", "src/control/client.ts", "src/control/server.ts", "src/engine/session.ts"],
    searches: ["connectControl", "ECONNREFUSED"],
    edits: [
      { path: "src/engine/start.ts", oldText: "  const socket = await connectControl(address)", newText: "  const socket = await retry(() => connectControl(address), { attempts: 5, backoffMs: 200 })" },
      { path: "src/control/client.ts", oldText: "export async function connectControl(address: string): Promise<Socket> {", newText: "export async function connectControl(address: string, signal?: AbortSignal): Promise<Socket> {" },
    ],
    test: "test/engine-start.test.ts",
    tests: ["retries while the socket is not listening", "gives up after five attempts"],
    plan: ["Find where the engine connects to the control socket", "Retry the connection with backoff", "Add a test for a slow socket", "Run the engine start tests"],
  },
}

const INVOICE_PAGES: Job = {
  title: "Add cursor pagination to the invoices endpoint",
  prompt: "GET /invoices returns every invoice for an account and times out for our largest customers. Switch it to cursor pagination with limit and cursor, and keep the response shape compatible for existing clients.",
  task: {
    files: ["packages/api/src/routes/invoices.ts", "packages/api/src/db/invoices.ts", "packages/shared/src/pagination.ts", "packages/api/src/routes/index.ts"],
    searches: ["listInvoices", "invoices.findMany"],
    edits: [
      { path: "packages/api/src/routes/invoices.ts", oldText: "  const invoices = await listInvoices(db, account.id)\n  return c.json({ invoices })", newText: "  const page = await listInvoicePage(db, account.id, { limit, cursor })\n  return c.json({ invoices: page.items, nextCursor: page.nextCursor })" },
      { path: "packages/api/src/db/invoices.ts", oldText: "  return db.invoices.findMany({ where: { accountId } })", newText: "  const rows = await db.invoices.findMany({ where: { accountId, ...after(cursor) }, orderBy: [{ createdAt: \"desc\" }, { id: \"desc\" }], take: limit + 1 })\n  return toPage(rows, limit)" },
    ],
    test: "packages/api/test/invoices.test.ts",
    tests: ["returns the first page with a next cursor", "returns no cursor on the last page"],
    plan: ["Read the invoices route and its query", "Page the query by creation date and id", "Return the next cursor with the list", "Add tests for the first and last page", "Run the invoices tests"],
  },
}

const PRICING_SHIFT: Job = {
  title: "Fix the layout shift on the pricing page",
  prompt: "Lighthouse reports a large layout shift on /pricing when the plan images load. Give the images fixed dimensions and make sure the plan table does not jump.",
  task: {
    files: ["src/components/PlanCard.tsx", "src/styles/pricing.css", "src/pages/pricing.tsx", "src/components/PricingTable.tsx"],
    searches: ["plan.image", "<img"],
    edits: [
      { path: "src/components/PlanCard.tsx", oldText: "      <img src={plan.image} alt={plan.name} />", newText: "      <img src={plan.image} alt={plan.name} width={320} height={180} />" },
      { path: "src/styles/pricing.css", oldText: ".plan-card img {\n  width: 100%;\n}", newText: ".plan-card img {\n  width: 100%;\n  height: auto;\n  aspect-ratio: 16 / 9;\n}" },
    ],
    test: "test/pricing.test.tsx",
    tests: ["gives every plan image a width and height", "keeps the table height while plans load"],
    plan: ["Find the images that load without a size", "Give each plan image fixed dimensions", "Keep the table from jumping while plans load", "Run the pricing page tests"],
  },
}

const NATIVE_UPGRADE: Job = {
  title: "Upgrade React Native to 0.82",
  prompt: "Upgrade React Native to 0.82 and fix whatever breaks. Run the test suite when you are done.",
  task: {
    files: ["package.json", "app/payments/applePay.ts", "app/screens/CheckoutScreen.tsx", "ios/Podfile.lock"],
    searches: ["NativeModules", "react-native"],
    edits: [
      { path: "package.json", oldText: "    \"react-native\": \"0.79.2\",", newText: "    \"react-native\": \"0.82.0\"," },
      { path: "app/payments/applePay.ts", oldText: "const { ApplePay } = NativeModules", newText: "const ApplePay = TurboModuleRegistry.get<ApplePaySpec>(\"ApplePay\")" },
    ],
    test: "app/__tests__/CheckoutScreen.test.tsx",
    tests: ["applies a discount code", "pays with Apple Pay"],
    plan: ["Bump react-native and its peer packages", "Replace the APIs 0.82 removed", "Run the test suite"],
  },
}

const NATIVE_UPGRADE_RUN = [
  "bun test v1.4.2",
  "",
  "app/__tests__/CheckoutScreen.test.tsx:",
  "(pass) renders the order summary [14.20ms]",
  "(fail) applies a discount code [9.81ms]",
  "",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: \"$42.00\"",
  "Received: \"$46.20\"",
  "",
  "      at <anonymous> (app/__tests__/CheckoutScreen.test.tsx:58:31)",
  "(fail) pays with Apple Pay [3.40ms]",
  "",
  "TypeError: null is not an object (evaluating 'ApplePay.canMakePayments')",
  "      at canPay (app/payments/applePay.ts:14:22)",
  "      at <anonymous> (app/__tests__/CheckoutScreen.test.tsx:91:11)",
  "",
  " 1 pass",
  " 2 fail",
  " 3 expect() calls",
  "Ran 3 tests across 1 file. [418.00ms]",
].join("\n")

const POSTGRES_SESSIONS: Job = {
  title: "Move session storage from Redis to Postgres",
  prompt: "We are dropping Redis. Move session storage to a Postgres sessions table: reads, writes, expiry, and the cleanup job. Keep the SessionStore interface the same so callers do not change.",
  task: {
    files: ["packages/api/src/sessions/store.ts", "packages/api/src/sessions/redis.ts", "packages/api/src/sessions/postgres.ts", "packages/api/src/middleware/auth.ts", "packages/api/src/routes/login.ts", "packages/api/src/routes/logout.ts", "packages/worker/src/jobs/session-cleanup.ts", "packages/api/src/db/schema.ts"],
    searches: ["redisSessions", "SESSION_TTL", "sessionKey("],
    edits: [
      { path: "packages/api/src/middleware/auth.ts", oldText: "import { redisSessions } from \"../sessions/redis\"", newText: "import { pgSessions } from \"../sessions/postgres\"" },
      { path: "packages/api/src/middleware/auth.ts", oldText: "  const session = await redisSessions.get(sessionKey(token))", newText: "  const session = await pgSessions.get(token)" },
      { path: "packages/api/src/routes/login.ts", oldText: "  await redisSessions.set(sessionKey(token), session, SESSION_TTL)", newText: "  await pgSessions.create(token, session, { expiresAt: Date.now() + SESSION_TTL })" },
      { path: "packages/api/src/routes/logout.ts", oldText: "  await redisSessions.del(sessionKey(token))", newText: "  await pgSessions.revoke(token)" },
      { path: "packages/worker/src/jobs/session-cleanup.ts", oldText: "  const keys = await redis.scan(\"session:*\")", newText: "  const removed = await db.sessions.deleteMany({ where: { expiresAt: { lt: new Date() } } })" },
      { path: "packages/api/src/db/schema.ts", oldText: "export const auditLog = pgTable(\"audit_log\", {", newText: "export const sessions = pgTable(\"sessions\", {\n  token: text(\"token\").primaryKey(),\n  data: jsonb(\"data\").notNull(),\n  expiresAt: timestamp(\"expires_at\").notNull(),\n})\n\nexport const auditLog = pgTable(\"audit_log\", {" },
    ],
    test: "packages/api/test/sessions.test.ts",
    tests: ["expires a session after its time to live", "removes expired sessions in one delete"],
    plan: ["Map every read and write of the Redis session store", "Add a sessions table and a Postgres store behind SessionStore", "Move the auth middleware and the login and logout routes", "Turn the cleanup job into one SQL delete", "Add tests for expiry and cleanup", "Remove the Redis client"],
  },
}

const DOCS_SEARCH: Job = {
  title: "Rebuild docs search on the prebuilt index",
  prompt: "Docs search is slow and misses obvious results. Rebuild it on an index made when the docs build, instead of indexing every page in the browser.",
  task: {
    files: ["src/lib/search/index.ts", "src/lib/search/tokenize.ts", "src/components/SearchBox.tsx", "src/pages/docs/[...slug].tsx", "scripts/build-search-index.ts"],
    searches: ["buildClientIndex", "lunr("],
    edits: [
      { path: "src/lib/search/index.ts", oldText: "  const index = buildClientIndex(await fetchAllPages())", newText: "  const index = await loadPrebuiltIndex(\"/search-index.json\")" },
      { path: "src/components/SearchBox.tsx", oldText: "  const results = useMemo(() => index.search(query), [index, query])", newText: "  const results = useMemo(() => rank(index.search(tokenize(query)), query).slice(0, 8), [index, query])" },
      { path: "scripts/build-search-index.ts", oldText: "// The index is built in the browser for now.", newText: "await writeFile(\"public/search-index.json\", JSON.stringify(buildIndex(pages)))" },
    ],
    test: "test/search.test.ts",
    tests: ["ranks a title match above a body match", "finds a page by a word in its heading"],
    plan: ["Read how search builds its index today", "Build the index when the docs build", "Load the prebuilt index in the search box", "Add tests for ranking"],
  },
}

const ACCESSIBILITY_AUDIT: Job = {
  title: "Audit the checkout flow for accessibility",
  prompt: "Audit the cart and checkout screens for accessibility: screen reader labels, touch target sizes, and color contrast. Fix what you can and list the rest.",
  task: {
    files: ["app/screens/CartScreen.tsx", "app/screens/CheckoutScreen.tsx", "app/components/PriceRow.tsx", "app/components/QuantityStepper.tsx", "app/components/Button.tsx", "app/theme/colors.ts"],
    searches: ["TouchableOpacity", "accessibilityLabel", "palette.gray400"],
    edits: [
      { path: "app/components/QuantityStepper.tsx", oldText: "      <TouchableOpacity onPress={onDecrement}>", newText: "      <Pressable onPress={onDecrement} accessibilityRole=\"button\" accessibilityLabel=\"Decrease quantity\" hitSlop={10}>" },
      { path: "app/screens/CartScreen.tsx", oldText: "        <TouchableOpacity onPress={() => remove(item.id)}>", newText: "        <Pressable onPress={() => remove(item.id)} accessibilityRole=\"button\" accessibilityLabel={`Remove ${item.name}`}>" },
      { path: "app/theme/colors.ts", oldText: "  muted: palette.gray400,", newText: "  muted: palette.gray600," },
      { path: "app/components/Button.tsx", oldText: "  minHeight: 36,", newText: "  minHeight: 44," },
    ],
    test: "app/__tests__/a11y.test.tsx",
    tests: ["labels every button on the checkout screen", "keeps touch targets at least 44 points"],
    plan: ["Split the audit across labels, touch targets, and contrast", "Add missing screen reader labels", "Grow touch targets under 44 points", "Fix low-contrast text colors", "List what still needs design input"],
    agents: ["Check screen reader labels on the cart and checkout screens", "Find touch targets smaller than 44 points", "Check text contrast against the theme colors"],
  },
}

const TRANSCRIPT_COMPACTION: Job = {
  title: "Compact the transcript store on startup",
  prompt: "Transcripts grow without bound. Compact the transcript store when the engine starts: drop superseded deltas and keep the last 2,048 items per session.",
  task: {
    files: ["src/store/transcript.ts", "src/store/compact.ts", "src/engine/start.ts", "src/store/index.ts"],
    searches: ["appendTranscript", "TRANSCRIPT_LIMIT"],
    edits: [
      { path: "src/engine/start.ts", oldText: "  await openTranscriptStore(dataDir)", newText: "  const store = await openTranscriptStore(dataDir)\n  await compactTranscripts(store, { keep: TRANSCRIPT_LIMIT })" },
      { path: "src/store/transcript.ts", oldText: "export const TRANSCRIPT_LIMIT = Infinity", newText: "export const TRANSCRIPT_LIMIT = 2_048" },
    ],
    test: "test/transcript-compact.test.ts",
    tests: ["keeps the last 2,048 items of a session", "drops deltas a message superseded"],
    plan: ["Read how transcripts are written", "Write a compaction pass", "Run it when the engine starts", "Add tests for compaction"],
  },
}

const USER_SORTING: Job = {
  title: "Sort the users table on the server",
  prompt: "The users table only sorts the rows on the current page. Move sorting to the server and keep the sort in the URL so shared links keep it.",
  task: {
    files: ["src/routes/users/+page.server.ts", "src/routes/users/+page.svelte", "src/lib/components/DataTable.svelte", "src/lib/server/users.ts"],
    searches: ["sortRows", "orderBy"],
    edits: [
      { path: "src/routes/users/+page.svelte", oldText: "  $: rows = sortRows(data.users, sort)", newText: "  $: rows = data.users" },
      { path: "src/lib/server/users.ts", oldText: "  return db.select().from(users).limit(limit).offset(offset)", newText: "  return db.select().from(users).orderBy(sortColumn(sort)).limit(limit).offset(offset)" },
    ],
    test: "src/lib/server/users.test.ts",
    tests: ["sorts by sign-up date across pages", "reads the sort from the URL"],
    plan: ["Read how the table sorts today", "Sort in the users query", "Keep the sort in the URL", "Add tests for each sortable column"],
  },
}

const ROLE_AUDIT: Job = {
  title: "Record role changes in the audit log",
  prompt: "Role changes do not show up in the audit log. Record each one with who made it, and show them on the user's page.",
  task: {
    files: ["src/lib/server/audit.ts", "src/lib/server/roles.ts", "src/routes/users/[id]/+page.server.ts", "src/routes/users/[id]/+page.svelte"],
    searches: ["setRole", "recordAudit"],
    edits: [
      { path: "src/lib/server/roles.ts", oldText: "  await db.update(users).set({ role }).where(eq(users.id, userId))", newText: "  await db.update(users).set({ role }).where(eq(users.id, userId))\n  await recordAudit(db, { actor: actor.id, action: \"role.changed\", target: userId, detail: { role } })" },
      { path: "src/routes/users/[id]/+page.server.ts", oldText: "  return { user }", newText: "  return { user, history: await auditFor(db, user.id) }" },
    ],
    test: "src/lib/server/audit.test.ts",
    tests: ["records who changed a role", "lists role changes newest first"],
    plan: ["Find where roles change", "Record each change with who made it", "Show role changes on the user page", "Add tests for the audit entries"],
  },
}

const DATABASE_MODULE: Job = {
  title: "Move the prod database to the shared module",
  prompt: "Replace the hand-written RDS resources in environments/prod with our shared database module, without recreating the instance.",
  task: {
    files: ["environments/prod/database.tf", "modules/database/main.tf", "modules/database/variables.tf", "environments/prod/moved.tf"],
    searches: ["aws_db_instance", "module \"database\""],
    edits: [
      { path: "environments/prod/database.tf", oldText: "resource \"aws_db_instance\" \"main\" {", newText: "module \"database\" {\n  source = \"../../modules/database\"" },
      { path: "environments/prod/moved.tf", oldText: "# Moved blocks for resources that changed address.", newText: "moved {\n  from = aws_db_instance.main\n  to   = module.database.aws_db_instance.this\n}" },
    ],
    test: "modules/database/tests/database.tftest.hcl",
    tests: ["plans no replacement for the prod instance", "keeps deletion protection on"],
    plan: ["Compare the prod resources with the module", "Switch prod to the module", "Add moved blocks so nothing is recreated", "Add a plan test"],
  },
}

const CI_CACHE: Job = {
  title: "Cache dependencies in CI",
  prompt: "CI spends four minutes installing dependencies on every run. Cache them keyed on the lockfile, and make sure a lockfile change misses the cache.",
  task: {
    files: [".github/workflows/ci.yml", ".github/actions/setup/action.yml", "scripts/ci/install.sh"],
    searches: ["bun install", "actions/cache"],
    edits: [
      { path: ".github/actions/setup/action.yml", oldText: "    - run: bun install", newText: "    - uses: actions/cache@v4\n      with:\n        path: ~/.bun/install/cache\n        key: bun-${{ hashFiles('bun.lock') }}\n    - run: bun install --frozen-lockfile" },
      { path: ".github/workflows/ci.yml", oldText: "      - run: bun install", newText: "      - uses: ./.github/actions/setup" },
    ],
    test: "scripts/ci/cache-key.test.ts",
    tests: ["changes the key when the lockfile changes", "keeps the key when only sources change"],
    plan: ["Time each CI step", "Cache the install keyed on the lockfile", "Check that a lockfile change misses the cache", "Add a test for the cache key"],
  },
}

const PROJECTS = ["runrail", "nifra", "mobile-app", "website", "admin-dashboard", "infra"] as const

type SeedStatus = "idle" | "completed" | "failed" | "stopped"

interface SeedThread {
  readonly id: string
  readonly projectId: string
  readonly title: string
  /** Minutes ago it was created, and last changed. */
  readonly ago: readonly [number, number]
  readonly status?: SeedStatus
  readonly unread?: true
  readonly script?: OfficeScript
}

function play(job: Job, startAfterMs: number): Turn & { readonly task: Task } {
  return { prompt: job.prompt, task: job.task, startAfterMs }
}

/** The thread open at load: idle and read, so every scripted thread is one the person is not looking at. */
const OPEN_THREAD = { id: "office-t11", projectId: "office-p4" }

/**
 * The open project's `.runrail/quests.md`, so the floor offers a repository's quests to review.
 * The season ends two months out, so the preview never shows an ended season.
 */
export function officeQuestFile(workspace: string, now = Date.now()): string | undefined {
  if (workspace !== `/Users/preview/code/${PROJECTS[3]}`) return undefined
  const ends = new Date(now + 60 * DAY)
  const date = `${String(ends.getFullYear())}-${String(ends.getMonth() + 1).padStart(2, "0")}-${String(ends.getDate()).padStart(2, "0")}`
  return `---\nseason: launch\ntitle: Launch quarter\nends: ${date}\n---\n\n## Review before you commit\n- counts: diff-reviewed\n- target: 5\n- per: week\n- xp: 50\n\n## Keep threads unblocked\n- counts: request-answered\n- target: 10\n- per: day\n- xp: 20\n- within: 10m\n\n## Open pull requests\n- counts: pr-opened\n- target: 3\n- per: season\n- xp: 100\n`
}

// Approvals come at about 5, 20, and 45 seconds, the failure at about 33, and the short work ends near 3 minutes.
const OFFICE_THREADS: readonly SeedThread[] = [
  { id: "office-t1", projectId: "office-p1", title: ENGINE_RETRY.title, ago: [95, 31], script: { role: "approval", ...play(ENGINE_RETRY, 2_800) } },
  { id: "office-t2", projectId: "office-p2", title: INVOICE_PAGES.title, ago: [140, 52], script: { role: "approval", ...play(INVOICE_PAGES, 17_800) } },
  { id: "office-t3", projectId: "office-p4", title: PRICING_SHIFT.title, ago: [70, 18], script: { role: "approval", ...play(PRICING_SHIFT, 42_800) } },
  { id: "office-t4", projectId: "office-p3", title: NATIVE_UPGRADE.title, ago: [185, 44], script: { role: "fail", ...play(NATIVE_UPGRADE, 30_000), output: NATIVE_UPGRADE_RUN } },
  {
    id: "office-t5",
    projectId: "office-p1",
    title: "Run the end-to-end suite before the release",
    ago: [24, 24],
    script: { role: "quiet", prompt: "Run the full end-to-end suite against the release build and tell me if anything fails.", startAfterMs: 4_000 },
  },
  { id: "office-t6", projectId: "office-p2", title: POSTGRES_SESSIONS.title, ago: [210, 12], script: { role: "work", ...play(POSTGRES_SESSIONS, 1_000), durationMs: 20 * MINUTE } },
  { id: "office-t7", projectId: "office-p4", title: DOCS_SEARCH.title, ago: [48, 9], script: { role: "work", ...play(DOCS_SEARCH, 6_000), durationMs: 3 * MINUTE } },
  { id: "office-t8", projectId: "office-p3", title: ACCESSIBILITY_AUDIT.title, ago: [76, 16], script: { role: "delegate", ...play(ACCESSIBILITY_AUDIT, 3_000), durationMs: 8 * MINUTE } },
  { id: "office-t9", projectId: "office-p2", title: "Add a health check for the billing worker", ago: [320, 14], status: "completed", unread: true },
  { id: "office-t10", projectId: "office-p1", title: "Raise the TypeScript target to ES2024", ago: [400, 27], status: "failed", unread: true },
  { ...OPEN_THREAD, title: "Write the changelog for 0.9", ago: [1_560, 1_310], status: "completed" },
  { id: "office-t12", projectId: "office-p3", title: "Find why Android cold start got slower", ago: [2_900, 1_700], status: "stopped" },
]

const STRESS_WORK: readonly (readonly [string, Job])[] = [
  ["office-p1", ENGINE_RETRY],
  ["office-p1", TRANSCRIPT_COMPACTION],
  ["office-p2", INVOICE_PAGES],
  ["office-p2", POSTGRES_SESSIONS],
  ["office-p3", NATIVE_UPGRADE],
  ["office-p3", ACCESSIBILITY_AUDIT],
  ["office-p4", PRICING_SHIFT],
  ["office-p4", DOCS_SEARCH],
  ["office-p5", USER_SORTING],
  ["office-p5", ROLE_AUDIT],
  ["office-p6", DATABASE_MODULE],
  ["office-p6", CI_CACHE],
]

const STRESS_RESTING: readonly (readonly [string, readonly string[]])[] = [
  ["office-p1", ["Fix memory growth in the event stream", "Clean up unused feature flags", "Add keyboard shortcuts to the composer", "Document the control protocol", "Speed up transcript loading"]],
  ["office-p2", ["Add retries to the webhook sender", "Rename the billing tables", "Add rate limiting to the public API", "Handle expired cards at renewal", "Upgrade the Postgres driver"]],
  ["office-p3", ["Retry failed push notifications", "Split the settings screen into tabs", "Keep the keyboard off the address form", "Add haptics to the checkout button", "Cache product images on the device"]],
  ["office-p4", ["Fix the broken links in the docs", "Lazy-load the analytics script", "Add dark mode to the blog", "Write the launch post for 0.9", "Show customer logos on the home page"]],
  ["office-p5", ["Add CSV export to the users page", "Fix time zones in the weekly report", "Show progress for long imports", "Index the user search query"]],
  ["office-p6", ["Bump Node to 24 in the Dockerfiles", "Add a staging environment", "Rotate the database credentials", "Alert on high queue latency"]],
]

const RESTING_STATES: readonly Pick<SeedThread, "status" | "unread">[] = [{ status: "completed" }, { status: "failed", unread: true }, { status: "completed", unread: true }, { status: "stopped" }, { status: "idle" }]

// Each prompt goes out as soon as its engine is up: twelve is the live-engine limit, and only a busy engine is safe from eviction.
const STRESS_THREADS: readonly SeedThread[] = [
  ...STRESS_WORK.map(([projectId, job], index): SeedThread => ({
    id: `stress-t${String(index + 1)}`,
    projectId,
    title: job.title,
    ago: [60 + index * 17, 5 + index],
    script: { role: "work", ...play(job, 0), durationMs: (28 + (index % 5)) * MINUTE },
  })),
  ...STRESS_RESTING.flatMap(([projectId, titles]) => titles.map((title) => ({ projectId, title }))).map(
    ({ projectId, title }, index): SeedThread => ({ id: `stress-t${String(STRESS_WORK.length + index + 1)}`, projectId, title, ago: [600 + index * 97, 20 + index * 41], ...RESTING_STATES[index % RESTING_STATES.length] }),
  ),
]

function scriptsOf(threads: readonly SeedThread[]): ReadonlyMap<string, OfficeScript> {
  const scripted = threads.flatMap((thread) => (thread.script === undefined ? [] : [[thread.id, thread.script] as const]))
  // In the order their prompts go out, so each engine is started before its prompt is due.
  return new Map(scripted.sort((a, b) => a[1].startAfterMs - b[1].startAfterMs))
}

const OFFICE_SCRIPTS = scriptsOf(OFFICE_THREADS)
const STRESS_SCRIPTS = scriptsOf(STRESS_THREADS)
const NO_SCRIPTS: ReadonlyMap<string, OfficeScript> = new Map()

/** Each scripted thread's first turn, by thread id, in the order the prompts go out. Empty unless `office`. */
export function officeScripts(scenario: PreviewScenario): ReadonlyMap<string, OfficeScript> {
  return scenario.office !== true ? NO_SCRIPTS : scenario.stress === true ? STRESS_SCRIPTS : OFFICE_SCRIPTS
}

/** The desktop state the office preview loads, as the host would read it from disk, dated from `now`. */
export function officeState(scenario: PreviewScenario, now = Date.now()) {
  const stress = scenario.stress === true
  return {
    version: 1,
    projects: PROJECTS.slice(0, stress ? 6 : 4).map((name, index) => ({ id: `office-p${String(index + 1)}`, path: `/Users/preview/code/${name}`, name, git: true, addedAt: now - (40 - index * 3) * DAY })),
    threads: (stress ? STRESS_THREADS : OFFICE_THREADS).map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      titled: true,
      createdAt: now - thread.ago[0] * MINUTE,
      updatedAt: now - thread.ago[1] * MINUTE,
      backend: "claude-code",
      mode: "agent",
      permission: "ask",
      lastStatus: thread.status ?? "idle",
      ...(thread.unread === true ? { unread: true } : {}),
    })),
    prefs: { sounds: true, notifications: true, quietMinutes: 2, officeMode: "office" },
    // Without `panels` the parser drops the whole layout, open thread included.
    layout: { ...(stress ? {} : { activeThreadId: OPEN_THREAD.id, activeProjectId: OPEN_THREAD.projectId }), panels: {} },
  }
}

/** The preview engine's helpers a scripted turn drives. */
export interface OfficeEngine {
  readonly cancelled: boolean
  event(type: string, fields: Record<string, unknown>): void
  live(type: string, fields: Record<string, unknown>): void
  record(item: { readonly kind: "notice"; readonly turnId: string; readonly level: "info" | "error"; readonly code: string }): void
  stream(turnId: string, text: string, pace?: number): Promise<void>
  tool(turnId: string, callId: string, name: string, presentation: Record<string, unknown>, output: string | undefined, ms: number, ok?: boolean): Promise<void>
  approval(turnId: string, action: string, capability: string): Promise<boolean>
  upsertFile(file: { readonly path: string; readonly change: "modified" | "added"; readonly staged: boolean; readonly additions: number; readonly deletions: number; readonly patch: string }): void
  finish(turnId: string, text: string): void
  stop(turnId: string): void
}

/** Plays a scripted thread's first turn, which the engine has already started. */
export async function playOfficeRole(engine: OfficeEngine, turnId: string, script: OfficeScript): Promise<void> {
  switch (script.role) {
    case "approval":
      return approvalTurn(engine, turnId, script.task)
    case "fail":
      return failTurn(engine, turnId, script.task, script.output)
    case "quiet":
      return quietTurn(engine, turnId)
    case "work":
    case "delegate":
      return longTurn(engine, turnId, script)
  }
}

async function approvalTurn(engine: OfficeEngine, turnId: string, task: Task): Promise<void> {
  const [search] = task.searches
  await think(engine, turnId, `I need to see how ${search} is used before changing it. Then a small edit, a test that covers it, and a run of that test before I say it works.`)
  await engine.stream(turnId, `I'll look at how \`${search}\` is used, make the change, and add a test for it.`)
  await find(engine, turnId, `${turnId}-c1`, task, search)
  await read(engine, turnId, `${turnId}-c2`, task.files[0])
  await read(engine, turnId, `${turnId}-c3`, task.files[1])
  plan(engine, turnId, task.plan, 1)
  for (const [index, change] of task.edits.entries()) await edit(engine, turnId, `${turnId}-e${String(index + 1)}`, change)
  await write(engine, turnId, `${turnId}-c4`, task.test, testFile(task))
  plan(engine, turnId, task.plan, task.plan.length - 1)
  if (engine.cancelled) return engine.stop(turnId)
  const command = `bun test ${task.test}`
  const callId = `${turnId}-run`
  const presentation = { kind: "shell", title: command, command, intent: "test" }
  // Announced before the approval, as a coding tool does, so the approval names the call it holds.
  engine.event("tool.started", { turnId, callId, name: "run_command", presentation })
  const approved = await engine.approval(turnId, command, "shell")
  if (engine.cancelled) return engine.stop(turnId)
  if (!approved) {
    engine.event("tool.completed", { turnId, callId, name: "run_command", ok: false, error: { code: "APPROVAL_DENIED", message: "approval denied for run_command" } })
    const text = `Okay, I won't run it. The change is in place; run \`${command}\` yourself when you're ready.`
    await engine.stream(turnId, text)
    engine.finish(turnId, text)
    return
  }
  // `tool` announces the call again; the timeline keeps it as the same row.
  await engine.tool(turnId, callId, "run_command", presentation, passing(task), 900)
  if (engine.cancelled) return engine.stop(turnId)
  plan(engine, turnId, task.plan, task.plan.length)
  engine.event("verification.completed", { name: "bun test", ok: true })
  await done(engine, turnId, task)
}

async function failTurn(engine: OfficeEngine, turnId: string, task: Task, output: string): Promise<void> {
  const [search] = task.searches
  await think(engine, turnId, "Before running the suite I want the obvious breakage fixed: anything that still uses the old API. Then the full test run will show what is left.")
  await engine.stream(turnId, `I'll make the change, fix what still uses \`${search}\`, and run the test suite.`)
  await read(engine, turnId, `${turnId}-c1`, task.files[0])
  await find(engine, turnId, `${turnId}-c2`, task, search)
  plan(engine, turnId, task.plan, 1)
  for (const [index, change] of task.edits.entries()) await edit(engine, turnId, `${turnId}-e${String(index + 1)}`, change)
  plan(engine, turnId, task.plan, task.plan.length - 1)
  await engine.tool(turnId, `${turnId}-run`, "run_command", { kind: "shell", title: "bun test", command: "bun test", intent: "test" }, output, 1_200, false)
  if (engine.cancelled) return engine.stop(turnId)
  engine.event("session.failed", { error: { code: "TURN_FAILED", message: "bun test exited with status 1" } })
  engine.record({ kind: "notice", turnId, level: "error", code: "TURN_FAILED" })
}

async function quietTurn(engine: OfficeEngine, turnId: string): Promise<void> {
  await think(engine, turnId, "The end-to-end suite takes a while against a release build. I'll start it and report back when it is done.")
  await engine.stream(turnId, "Starting the end-to-end suite against the release build. It takes a few minutes.")
  if (engine.cancelled) return engine.stop(turnId)
  const command = "bun run e2e"
  const callId = `${turnId}-e2e`
  engine.event("tool.started", { turnId, callId, name: "run_command", presentation: { kind: "shell", title: command, command } })
  engine.event("tool.delta", { turnId, callId, text: "$ playwright test --project=release\n\nRunning 186 tests using 4 workers\n" })
  // Nothing at all from here until the turn is stopped: any frame would end the silence the tray watches for.
  while (!engine.cancelled) await sleep(250)
  engine.stop(turnId)
}

/**
 * Reads, searches, and edits every second or three until `durationMs` is up, the plan moving with
 * the time. A delegating turn first hands parts to subagents, which work alongside it, read-only,
 * and report back one by one through the middle of the run.
 */
async function longTurn(engine: OfficeEngine, turnId: string, script: LongScript): Promise<void> {
  const { task, durationMs } = script
  const agents = script.role === "delegate" ? (task.agents ?? []) : []
  const agentIds = agents.map((_, index) => `${turnId}-a${String(index + 1)}`)
  const reportAt = agents.map((_, index) => durationMs * (0.45 + (0.3 * index) / agents.length))
  const started = Date.now()
  if (agents.length > 0) {
    await think(engine, turnId, "These checks do not depend on each other, so subagents can run them side by side while I fix what they find.")
    await engine.stream(turnId, `This splits cleanly: ${String(agents.length)} subagents take the checks, and I'll fix what they find as it comes in.`)
  } else {
    await think(engine, turnId, `This touches ${String(task.files.length)} files. Finding every use of ${task.searches[0]} first means nothing gets missed, and each change can stay small.`)
    await engine.stream(turnId, `First, ${lowerFirst(task.plan[0])}. Then I'll work through the rest one step at a time.`)
  }
  plan(engine, turnId, task.plan, 0)
  for (const [index, title] of agents.entries()) {
    if (engine.cancelled) break
    engine.live("agent.spawned", { turnId, callId: agentIds[index], title, agentType: "explore" })
    await pause(engine, 400)
  }
  let step = 0
  let reported = 0
  let ownSteps = 0
  let wroteTests = false
  for (let action = 0; Date.now() - started < durationMs; action += 1) {
    if (engine.cancelled) return engine.stop(turnId)
    const elapsed = Date.now() - started
    if (reported < agents.length && elapsed >= reportAt[reported]) {
      engine.live("agent.completed", { turnId, callId: agentIds[reported], ok: true })
      await engine.stream(turnId, `"${agents[reported]}" is back. Applying what it found.`)
      reported += 1
    }
    const reached = Math.min(task.plan.length - 1, Math.floor((elapsed / durationMs) * task.plan.length))
    if (reached > step) {
      await engine.stream(turnId, `${task.plan[step]}: done. Next, ${lowerFirst(task.plan[reached])}.`)
      step = reached
      plan(engine, turnId, task.plan, step)
    }
    const callId = `${turnId}-w${String(action)}`
    const helping = agentIds.slice(reported)
    if (action % 2 === 1 && helping.length > 0) {
      engine.live("lineage", { parentCallId: helping[Math.floor(action / 2) % helping.length], callId })
      await read(engine, turnId, callId, task.files[(action * 3) % task.files.length])
    } else if (!wroteTests && elapsed > durationMs * 0.66) {
      wroteTests = true
      await write(engine, turnId, callId, task.test, testFile(task))
    } else {
      await routine(engine, turnId, callId, task, ownSteps)
      ownSteps += 1
    }
    await pause(engine, between(1_000, 3_000))
  }
  if (engine.cancelled) return engine.stop(turnId)
  plan(engine, turnId, task.plan, task.plan.length)
  await done(engine, turnId, task)
}

const NOTES: readonly ((path: string) => string)[] = [
  (path) => `Updated \`${path}\`. Checking the next caller.`,
  (path) => `\`${path}\` needed its types adjusted too; done.`,
  (path) => `\`${path}\` is done; nothing else in it uses the old path.`,
]

/** One step of a long turn: mostly reading, a search now and then, and an edit every few steps. */
async function routine(engine: OfficeEngine, turnId: string, callId: string, task: Task, action: number): Promise<void> {
  const file = task.files[action % task.files.length]
  switch (action % 8) {
    case 0:
      return find(engine, turnId, callId, task, task.searches[Math.floor(action / 8) % task.searches.length])
    case 3:
    case 6: {
      const change = task.edits[Math.floor(action / 4) % task.edits.length]
      await edit(engine, turnId, callId, change)
      if (action % 16 === 6 && !engine.cancelled) await engine.stream(turnId, NOTES[Math.floor(action / 16) % NOTES.length](change.path))
      return
    }
    case 5: {
      const folder = file.slice(0, Math.max(0, file.lastIndexOf("/"))) || "."
      return engine.tool(turnId, callId, "list_files", { kind: "list", title: folder, path: folder }, undefined, between(100, 220))
    }
    default:
      return read(engine, turnId, callId, file)
  }
}

async function done(engine: OfficeEngine, turnId: string, task: Task): Promise<void> {
  const text = ["Done:", "", ...task.plan.map((step) => `- ${step}`), "", "Review the diff and commit when you're happy."].join("\n")
  await engine.stream(turnId, text, 10)
  if (engine.cancelled) return engine.stop(turnId)
  engine.finish(turnId, text)
}

async function think(engine: OfficeEngine, turnId: string, text: string): Promise<void> {
  const words = text.split(" ")
  for (let index = 0; index < words.length && !engine.cancelled; index += 4) {
    engine.live("reasoning.delta", { turnId, itemId: "r1", text: `${index === 0 ? "" : " "}${words.slice(index, index + 4).join(" ")}` })
    await sleep(16)
  }
  engine.live("reasoning.completed", { turnId, itemId: "r1" })
}

function plan(engine: OfficeEngine, turnId: string, steps: readonly string[], current: number): void {
  engine.live("plan.updated", { turnId, steps: steps.map((text, index) => ({ text, status: index < current ? "completed" : index === current ? "in_progress" : "pending" })) })
}

function find(engine: OfficeEngine, turnId: string, callId: string, task: Task, query: string): Promise<void> {
  const hits = task.files.slice(0, 3).map((file, index) => `${file}:${String(14 + index * 23)}`)
  return engine.tool(turnId, callId, "search_files", { kind: "search", title: query, query }, hits.join("\n"), between(200, 420))
}

function read(engine: OfficeEngine, turnId: string, callId: string, path: string): Promise<void> {
  return engine.tool(turnId, callId, "read_file", { kind: "read", title: path, path }, undefined, between(120, 320))
}

async function edit(engine: OfficeEngine, turnId: string, callId: string, change: Edit): Promise<void> {
  const { path, oldText, newText } = change
  await engine.tool(turnId, callId, "edit_file", { kind: "edit", title: path, path, edits: [{ oldText, newText }] }, undefined, between(280, 520))
  if (engine.cancelled) return
  engine.upsertFile({ path, change: "modified", staged: false, additions: lineCount(newText), deletions: lineCount(oldText), patch: hunk(oldText, newText) })
}

async function write(engine: OfficeEngine, turnId: string, callId: string, path: string, content: string): Promise<void> {
  await engine.tool(turnId, callId, "write_file", { kind: "write", title: path, path, content }, undefined, between(240, 420))
  if (engine.cancelled) return
  engine.upsertFile({ path, change: "added", staged: false, additions: lineCount(content), deletions: 0, patch: hunk("", content) })
}

function testFile(task: Task): string {
  const cases = task.tests.map((name) => [`test(${JSON.stringify(name)}, async () => {`, `  expect((await scenario(${JSON.stringify(name)})).ok).toBe(true)`, "})"].join("\n"))
  return [`import { expect, test } from "bun:test"`, `import { scenario } from "./helpers"`, "", cases.join("\n\n")].join("\n")
}

function passing(task: Task): string {
  const count = String(task.tests.length)
  return ["bun test v1.4.2", "", `${task.test}:`, ...task.tests.map((name, index) => `(pass) ${name} [${(0.4 + index * 0.3).toFixed(2)}ms]`), "", ` ${count} pass`, " 0 fail", ` ${count} expect() calls`, `Ran ${count} tests across 1 file. [24.00ms]`].join("\n")
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length
}

/** A one-hunk patch from `oldText` to `newText`, as the Review pane reads it. */
function hunk(oldText: string, newText: string): string {
  const before = oldText.length === 0 ? [] : oldText.split("\n")
  const after = newText.split("\n")
  const header = before.length === 0 ? `@@ -0,0 +1,${String(after.length)} @@` : `@@ -12,${String(before.length)} +12,${String(after.length)} @@`
  return [header, ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)].join("\n")
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function between(low: number, high: number): number {
  return low + Math.floor(Math.random() * (high - low))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits, waking early once the turn is stopped. */
async function pause(engine: OfficeEngine, ms: number): Promise<void> {
  const end = Date.now() + ms
  while (!engine.cancelled && Date.now() < end) await sleep(Math.min(200, end - Date.now()))
}
