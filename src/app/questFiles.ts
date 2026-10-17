import { toHostError } from "../host"
import { GitDiffSchema, parseOr, WorkspaceReadSchema } from "../protocol/schemas"
import { projectRpc } from "./engines"
import { MAX_QUEST_FILE_BYTES } from "./persist"
import { gameOn, useQuestFiles, type QuestFile } from "./play"
import { parseQuests, QUEST_FILE, questHash } from "./quests"
import { get, threadById, useApp } from "./store"

/**
 * Reads each project's `.runrail/quests.md` from the project root's working tree, when the project
 * is opened and when the window comes back to the front. A file git sees as changed or new is
 * marked "Local edits"; reading the committed copy needs a core read at a ref, deferred.
 */

const READ_EVERY_MS = 60_000
const TOO_BIG = "The file is larger than 32 KB."
const lastRead = new Map<string, number>()
const reading = new Map<string, Promise<void>>()

export function readQuestFile(projectId: string, force = false): Promise<void> {
  if (!gameOn(get().prefs)) return Promise.resolve()
  const pending = reading.get(projectId)
  if (pending !== undefined) return pending
  const last = lastRead.get(projectId)
  if (!force && last !== undefined && Date.now() - last < READ_EVERY_MS) return Promise.resolve()
  lastRead.set(projectId, Date.now())
  const task = load(projectId).finally(() => reading.delete(projectId))
  reading.set(projectId, task)
  return task
}

async function load(projectId: string): Promise<void> {
  let file: QuestFile | null
  try {
    const read = parseOr(WorkspaceReadSchema, await projectRpc(projectId, "workspace.read", { path: QUEST_FILE, maxBytes: MAX_QUEST_FILE_BYTES + 1 }))
    if (read === undefined) return
    const tooBig = read.truncated === true || (read.bytes ?? 0) > MAX_QUEST_FILE_BYTES
    file = {
      hash: questHash(read.content),
      text: read.content,
      result: tooBig ? { ok: false, line: 1, reason: TOO_BIG } : parseQuests(read.content),
      localEdits: await changedLocally(projectId),
    }
  } catch (error) {
    const code = toHostError(error).code
    // The engine refuses a file over the limit, or one that is not text, without sending it.
    const reason = code === "CONTROL_WORKSPACE_LIMIT" ? TOO_BIG : code === "CONTROL_WORKSPACE_BINARY" ? "The file is not text." : undefined
    if (reason !== undefined) file = { hash: questHash(code), text: "", result: { ok: false, line: 1, reason }, localEdits: false }
    else if (code === "CONTROL_WORKSPACE_NOT_FOUND") file = null
    // Anything else keeps what was read before; the next focus tries again.
    else return
  }
  useQuestFiles.setState({ [projectId]: file })
}

/** Whether git lists the quest file as changed from HEAD or not yet committed. */
async function changedLocally(projectId: string): Promise<boolean> {
  try {
    const diff = parseOr(GitDiffSchema, await projectRpc(projectId, "git.diff", { scope: "head", paths: [QUEST_FILE], includeUntracked: true, contextLines: 0, maxFiles: 1, maxBytes: MAX_QUEST_FILE_BYTES * 2 }))
    return (diff?.files.length ?? 0) > 0
  } catch {
    // Not a git repository, or git is unavailable: nothing to compare with.
    return false
  }
}

function openProject(): string | undefined {
  const { layout } = get()
  return threadById(layout.activeThreadId)?.projectId ?? layout.activeProjectId
}

let started = false

export function initQuests(): void {
  if (started) return
  started = true
  const read = (force: boolean): void => {
    const projectId = openProject()
    if (projectId !== undefined) void readQuestFile(projectId, force)
  }
  read(false)
  useApp.subscribe((state, previous) => {
    const opened = state.layout.activeProjectId !== previous.layout.activeProjectId || state.layout.activeThreadId !== previous.layout.activeThreadId
    if (opened || gameOn(state.prefs) !== gameOn(previous.prefs)) read(false)
  })
  window.addEventListener("focus", () => read(false))
}
