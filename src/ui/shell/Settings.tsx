import { ArrowLeft, AudioLines, Bot, Cable, Check, CircleAlert, Cpu, Download, FileText, FolderOpen, History, Keyboard, Mic, Minus, Plus, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, SquareTerminal, Trash, Wrench, X } from "lucide-react"
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react"
import { useShallow } from "zustand/react/shallow"
import { confirmAction, EDITOR_LABELS, openDialog, pickProject, reveal, useEditors } from "../../app/actions"
import { useCatalog } from "../../app/catalog"
import { resetDiagnostics, useDiagnostics } from "../../app/diagnostics"
import { projectCapability, projectContract, restartEngines, closeProject } from "../../app/engines"
import { NIFRA_SETTING_HINT, nifraOn } from "../../app/nifra"
import { readAllProjectGit } from "../../app/projectGit"
import { setPlanLimits } from "../../app/planUsage"
import { MAX_CHAIN, SENDS_PER_TURN } from "../../app/threadAgent"
import { BACKEND_LABELS, glassAvailable, paletteChange, MAX_INSTRUCTIONS, MAX_VOICE_WORD, MAX_VOICE_WORDS, PASTE_THRESHOLDS, QUIET_MINUTES, VOICE_RATES, type NotifyOn, type VoicePrefs, type PasteThreshold, type Prefs, type QuietMinutes } from "../../app/persist"
import { ACCESS_LABELS, ACCESS_ORDER, accessOf, type Access } from "../../app/access"
import { selectionProblem, TOOL_BACKENDS, toolState, type ToolState } from "../../app/picker"
import { setStartDefault } from "../../app/connectionSettings"
import { get, runtimeOf, set, setPrefs, startSelection, toast, useApp, type SettingsSection } from "../../app/store"
import { OTHER_TOOL_LABELS, useImportRevision, withImported } from "../../app/otherTools"
import { checkForUpdates, installUpdate, useUpdates } from "../../app/updates"
import { BACKENDS, getHost, toHostError, type BackendId, type EditorId, type EngineInfo, type FoundInstructions, type LoginItemStatus, type ModelProgress, type ProjectInstructions, type Thinking, type VoiceDevice, type VoiceModel, type WakeServiceStatus } from "../../host"
import { compactPath, plural, relativeTime } from "../../lib/format"
import type { CapabilityState, Contract } from "../../protocol/schemas"
import { Button, cx, CopyButton, IconButton, Kbd, Menu, Segmented, Spinner, Toggle } from "../common"
import { playTone, type Tone } from "../../lib/tones"
import { readNotifyStatus, requestNotifications, useNotifyStatus } from "../../app/notifications"
import { resetLessons } from "../../app/learning"
import { learnLevel } from "../../app/lessons"
import { gameOn } from "../../app/play"
import { useWords } from "../../app/platformWords"
import { setOfficeMode } from "../../app/office"
import { dictationAvailable, hostListens, readAloudAvailable, speak, systemVoices, useVoice, voiceEngine, type SystemVoice } from "../../app/voice"
import { ConnectionsPage } from "../connections/ConnectionsPage"
import { ComputerSettings } from "./ComputerSettings"
import { DIFF_LAYOUTS } from "../diff/DiffView"
import { ModelPicker } from "../thread/ModelPicker"
import { ProjectSkills } from "../views/Extensions"
import { AccentDots, PaletteCards, ThemeCards } from "./appearance"
import { ImportProviders } from "./ImportSettings"
import { ProjectFolders } from "./ProjectFolders"
import { PhoneAccess } from "./PhoneAccess"
import { QuickChat } from "./QuickChat"
import { RemoteMachines } from "./RemoteMachines"
import { ProjectSignIns } from "./ProjectSignIns"
import { ProjectGitLine, useCodeHostRecords } from "./ProjectGit"
import { revealSetting } from "./revealSetting"
import { McpSection } from "./McpSettings"
import { searchSettings, SECTION_LABELS, type PageSection, type SettingEntry } from "./settingsIndex"
import { SHORTCUTS } from "./shortcuts"
import { SubagentEditor } from "./SubagentSettings"

/**
 * Settings, as a page of its own (PI and Codex both do this): a rail of sections with a search box
 * and a way back, and one section at a time beside it. Search finds any row by its label.
 */

/** The engine reads at most this much of a context file. */
const MAX_PROJECT_INSTRUCTIONS = 256 * 1024

const SECTION_ICON: Readonly<Record<PageSection, ReactNode>> = {
  general: <Settings2 size={14} />,
  ai: <SquareTerminal size={14} />,
  voice: <Mic size={14} />,
  instructions: <FileText size={14} />,
  mcp: <Cable size={14} />,
  models: <Cpu size={14} />,
  permissions: <ShieldCheck size={14} />,
  skills: <Sparkles size={14} />,
  agents: <Bot size={14} />,
  projects: <FolderOpen size={14} />,
  import: <History size={14} />,
  shortcuts: <Keyboard size={14} />,
  developer: <Wrench size={14} />,
}

const NAV: readonly (readonly PageSection[])[] = [
  ["general", "ai", "voice", "models", "permissions"],
  ["instructions", "skills", "mcp", "agents"],
  ["projects", "import", "shortcuts", "developer"],
]

/** "connections" is a place inside Models, not a section of its own. */
function pageOf(section: SettingsSection): PageSection {
  return section === "connections" ? "models" : section
}

export function SettingsPage() {
  const section = useApp((state) => state.settings)
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement | null>(null)
  const close = (): void => {
    if (unsavedEditors.size === 0) return void set({ settings: false })
    confirmAction({
      title: "Leave without saving?",
      body: "Your changes to the instructions are not saved.",
      confirm: "Discard changes",
      danger: true,
      onConfirm: () => {
        unsavedEditors.clear()
        set({ settings: false })
      },
    })
  }

  // "Connections" from the model menu or the palette lands on that part of Models.
  useEffect(() => {
    if (section === "connections") revealSetting("connections")
  }, [section])

  // Escape goes back to the app, unless a dialog or a field's own Escape handles it first.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented && get().dialog === undefined) {
        if (document.activeElement === search.current && query.length > 0) setQuery("")
        else close()
      }
      if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [query])

  if (section === false) return null
  const page = pageOf(section)
  const results = searchSettings(query)
  const go = (entry: SettingEntry): void => {
    setQuery("")
    set({ settings: entry.section })
    revealSetting(entry.id)
  }

  return (
    <div className="settings-shell">
      <nav className="settings-rail" aria-label="Settings sections">
        <div className="settings-rail-top" data-tauri-drag-region />
        <button type="button" className="settings-back" onClick={close}>
          <ArrowLeft size={14} /> Back to app
        </button>
        <label className="settings-search">
          <Search size={13} />
          <input
            ref={search}
            type="search"
            value={query}
            maxLength={80}
            placeholder="Search settings"
            aria-label="Search settings"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const first = results[0]
              if (event.key === "Enter" && first !== undefined) go(first)
            }}
          />
          {query.length > 0 && (
            <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={12} />
            </button>
          )}
        </label>
        {NAV.map((group, index) => (
          <div key={index} className="settings-nav-group">
            {group.map((id) => (
              <button key={id} type="button" className={cx("settings-nav-item", query.length === 0 && page === id && "is-active")} aria-current={query.length === 0 && page === id ? "page" : undefined} onClick={() => {
                setQuery("")
                set({ settings: id })
              }}>
                {SECTION_ICON[id]}
                {SECTION_LABELS[id]}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className="settings-main" aria-label="Settings">
        <div className="settings-main-top" data-tauri-drag-region />
        <div className="settings-column" key={query.length > 0 ? "search" : page}>
          {query.length > 0 ? (
            <SearchResults query={query} results={results} onPick={go} />
          ) : (
            <>
              {page === "general" && <General />}
              {page === "ai" && <AgentSection />}
              {page === "voice" && <VoiceSection />}
              {page === "instructions" && <InstructionsSection />}
              {page === "mcp" && <McpSection />}
              {page === "models" && <Models />}
              {page === "permissions" && <Permissions />}
              {page === "skills" && <SkillsSection />}
              {page === "agents" && <Subagents />}
              {page === "projects" && <Projects />}
              {page === "import" && <ImportSection />}
              {page === "shortcuts" && <Shortcuts />}
              {page === "developer" && <Developer />}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function SearchResults({ query, results, onPick }: { readonly query: string; readonly results: readonly SettingEntry[]; readonly onPick: (entry: SettingEntry) => void }) {
  return (
    <div className="settings-page">
      <h2>Results</h2>
      {results.length === 0 ? (
        <p className="settings-lead">No setting matches "{query.trim()}".</p>
      ) : (
        <ul className="settings-results">
          {results.map((entry) => (
            <li key={entry.id}>
              <button type="button" className="settings-result" onClick={() => onPick(entry)}>
                <span className="settings-result-icon">{SECTION_ICON[entry.section]}</span>
                <span className="settings-result-label">{entry.label}</span>
                <span className="settings-result-section">{SECTION_LABELS[entry.section]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Row({ id, label, hint, children }: { readonly id?: string; readonly label: string; readonly hint?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="setting-row" {...(id === undefined ? {} : { "data-setting": id })}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint !== undefined && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

/** A section's own heading and lead line. */
function Head({ title, lead }: { readonly title: string; readonly lead?: ReactNode }) {
  return (
    <>
      <h2>{title}</h2>
      {lead !== undefined && <p className="settings-lead">{lead}</p>}
    </>
  )
}

function usePrefs(): Prefs {
  return useApp(useShallow((state) => state.prefs))
}

function LearnRows() {
  const level = useApp((state) => learnLevel(state.prefs))
  const seen = useApp((state) => state.learning.seen.length)
  return (
    <>
      <Row id="learn-mode" label="Learn mode" hint="A short note beside the agent's steps saying what it is doing, from a fixed list written for Runrail, never generated. Brief shows a title, Standard a sentence or two, Deep adds a fact and what to watch for.">
        <Segmented
          label="Learn mode"
          value={level}
          onChange={(learn) => setPrefs({ learn })}
          options={[
            { value: "off", label: "Off" },
            { value: "brief", label: "Brief" },
            { value: "standard", label: "Standard" },
            { value: "deep", label: "Deep" },
          ]}
        />
      </Row>
      {seen > 0 && (
        <Row id="lessons-seen" label="Lessons seen" hint={`Each lesson shows once at each level. ${plural(seen, "lesson")} seen so far.`}>
          <Button size="sm" variant="ghost" onClick={resetLessons}>
            Show them again
          </Button>
        </Row>
      )}
    </>
  )
}

function GameRow() {
  const on = useApp((state) => gameOn(state.prefs))
  return (
    <Row id="game-layer" label="Game layer" hint="XP, levels, and daily quests for what you confirm: answering requests, reviewing diffs before you commit, reading lessons. A repository can add its own quests in .runrail/quests.md, which you accept first. It all stays on this machine.">
      <Toggle label="Game layer" checked={on} onChange={(game) => setPrefs({ game })} />
    </Row>
  )
}

function General() {
  const prefs = usePrefs()
  const platform = useApp((state) => state.platform)
  const words = useWords()
  const editors = useEditors()
  const desktopRows = platform === "macos" || platform === "linux" || getHost().kind === "preview"
  return (
    <div className="settings-page">
      <Head title="General" />
      <div className="setting-block" data-setting="theme">
        <div className="setting-label">Theme</div>
        <ThemeCards value={prefs.theme} onChange={(theme) => setPrefs({ theme })} />
      </div>
      <div className="setting-block" data-setting="palette">
        <div className="setting-label">Palette</div>
        <div className="setting-hint">Japanese flowers, each with a light and a dark side. Status keeps its own colors.</div>
        <PaletteCards value={prefs.palette} onChange={(palette) => setPrefs(paletteChange(prefs, palette))} />
      </div>
      <Row id="accent" label="Accent" hint="Buttons, focus, and selection. Status keeps its own colors either way.">
        <AccentDots value={prefs.accent} palette={prefs.palette} onChange={(accent) => setPrefs({ accent })} />
      </Row>
      <Row id="text-size" label="Text size" hint="For the whole window: messages, code, and controls.">
        <Segmented
          label="Text size"
          value={prefs.textSize}
          onChange={(textSize) => setPrefs({ textSize })}
          options={[
            { value: "small", label: "Small" },
            { value: "default", label: "Default" },
            { value: "large", label: "Large" },
          ]}
        />
      </Row>
      {glassAvailable(platform) && (
        <Row id="glass" label="Translucent window" hint="Shows the desktop through the sidebar and round the content, and frosts menus and dialogs. Solid while the app's theme differs from the system's, or a flower palette is on.">
          <Toggle label="Translucent window" checked={prefs.sidebarGlass} onChange={(sidebarGlass) => setPrefs({ sidebarGlass })} />
        </Row>
      )}
      <Row id="density" label="Density" hint="Compact fits more of the timeline and sidebar on screen.">
        <Segmented
          label="Density"
          value={prefs.density}
          onChange={(density) => setPrefs({ density })}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
      </Row>
      <Row id="thread-timestamps" label="Thread timestamps" hint="Show the last activity time beside threads in the sidebar.">
        <Toggle label="Thread timestamps" checked={prefs.showThreadTimestamps} onChange={(showThreadTimestamps) => setPrefs({ showThreadTimestamps })} />
      </Row>
      <Row id="ui-font" label="Interface font" hint="Rounded uses the system's rounded face for menus, messages, and controls.">
        <Segmented
          label="Interface font"
          value={prefs.uiFont}
          onChange={(uiFont) => setPrefs({ uiFont })}
          options={[
            { value: "system", label: "System" },
            { value: "rounded", label: "Rounded" },
          ]}
        />
      </Row>
      <Row id="code-font" label="Code font" hint="For code, diffs, and the terminal.">
        <Segmented
          label="Code font"
          value={prefs.codeFont}
          onChange={(codeFont) => setPrefs({ codeFont })}
          options={[
            { value: "sf-mono", label: "SF Mono" },
            { value: "menlo", label: "Menlo" },
            { value: "monaco", label: "Monaco" },
          ]}
        />
      </Row>
      <Row id="editor" label="Open files in">
        <select className="select" value={editors.editor} onChange={(event) => setPrefs({ editor: event.target.value as EditorId })} aria-label="Editor">
          {(Object.keys(EDITOR_LABELS) as EditorId[])
            .filter((id) => editors.list.includes(id))
            .map((id) => (
              <option key={id} value={id}>
                {EDITOR_LABELS[id]}
              </option>
            ))}
        </select>
      </Row>
      <Row id="motion" label="Reduce motion" hint="Follows the system's Reduce motion setting, or always keeps animations to a minimum.">
        <Segmented
          label="Reduce motion"
          value={prefs.motion}
          onChange={(motion) => setPrefs({ motion })}
          options={[
            { value: "system", label: "System" },
            { value: "reduce", label: "Always" },
          ]}
        />
      </Row>
      <h3>Office</h3>
      <Row id="office-mode" label="Office mode" hint="Each project is a room and each thread a person at a desk. People move only while their thread works, and clicking one opens the thread beside the floor.">
        <Toggle label="Office mode" checked={prefs.officeMode !== "off"} onChange={(on) => setOfficeMode(on)} />
      </Row>
      {prefs.officeMode !== "off" && (
        <Row id="office-open-on" label="Open on" hint="What Runrail shows when it starts. The sidebar's Office item and the floor's List switch move between them any time.">
          <Segmented
            label="Open on"
            value={prefs.officeMode}
            onChange={(officeMode) => setPrefs({ officeMode })}
            options={[
              { value: "office", label: "Office floor" },
              { value: "list", label: "Thread list" },
            ]}
          />
        </Row>
      )}
      {prefs.officeMode !== "off" && <GameRow />}
      <LearnRows />
      <h3>While threads run</h3>
      <Row id="notifications" label="Notes in the window" hint="A note in the corner when a thread you are not looking at finishes or needs approval. The inbox in the bottom-left menu keeps them either way.">
        <Toggle label="Notes in the window" checked={prefs.notifications} onChange={(notifications) => setPrefs({ notifications })} />
      </Row>
      <SystemNotificationsRow />
      <Row id="notify-on" label="Notify about" hint={`For notes, ${words.notificationsInText}, and sounds alike.`}>
        <div className="check-group">
          {NOTIFY_CHOICES.map(([key, label]) => (
            <label key={key} className="check-inline">
              <input type="checkbox" checked={prefs.notifyOn[key]} onChange={(event) => setPrefs({ notifyOn: { ...prefs.notifyOn, [key]: event.target.checked } })} />
              {label}
            </label>
          ))}
        </div>
      </Row>
      <Row id="sounds" label="Sounds" hint="A soft tone when a thread you are not looking at finishes, fails, or needs approval, for the events chosen above. A thread asking for approval raises its hand with three rising notes.">
        <Toggle label="Sounds" checked={prefs.sounds} onChange={(sounds) => setPrefs({ sounds })} />
      </Row>
      {prefs.sounds && (
        <Row id="sound-volume" label="Volume" hint="Play a tone to hear it at this level.">
          <div className="tone-previews">
            {TONE_PREVIEWS.map(([tone, label]) => (
              <Button key={tone} size="sm" variant="ghost" onClick={() => playTone(tone, prefs.volume)}>
                {label}
              </Button>
            ))}
          </div>
          <input type="range" className="volume-range" min={0} max={1} step={0.05} value={prefs.volume} aria-label="Volume" onChange={(event) => setPrefs({ volume: Number(event.target.value) })} />
        </Row>
      )}
      <Row id="quiet-minutes" label="Flag quiet threads after" hint="A running thread that sends nothing for this long shows in Waiting on you, with what it was running. Long builds and test runs can be quiet too, so nothing is stopped.">
        <select className="select" value={prefs.quietMinutes} onChange={(event) => setPrefs({ quietMinutes: Number(event.target.value) as QuietMinutes })} aria-label="Flag quiet threads after">
          {QUIET_MINUTES.map((value) => (
            <option key={value} value={value}>
              {value === 0 ? "Never" : `${String(value)} minutes`}
            </option>
          ))}
        </select>
      </Row>
      {desktopRows && (
        <>
          <Row id="keep-awake" label={`Keep the ${words.computer} awake while working`} hint={`While any thread is running, the ${words.computer} does not go to sleep on its own.`}>
            <Toggle label={`Keep the ${words.computer} awake while working`} checked={prefs.keepAwake} onChange={(keepAwake) => setPrefs({ keepAwake })} />
          </Row>
          {prefs.keepAwake && (
            <Row id="keep-display-awake" label="Keep the display on too" hint={`Otherwise the display can still dim and turn off while the ${words.computer} keeps working.`}>
              <Toggle label="Keep the display on too" checked={prefs.keepDisplayAwake} onChange={(keepDisplayAwake) => setPrefs({ keepDisplayAwake })} />
            </Row>
          )}
        </>
      )}
      {desktopRows && <LoginItemRow />}
      {desktopRows && <WakeServiceRow />}
      <Row id="confirm-quit" label="Ask before quitting while threads or runs go" hint="Quitting stops running turns and workflow, setup and eval runs. A stopped thread can be continued later.">
        <Toggle label="Ask before quitting while threads or runs go" checked={prefs.confirmQuit} onChange={(confirmQuit) => setPrefs({ confirmQuit })} />
      </Row>
      <Row id="nifra" label="Nifra in Nifra projects" hint={`${NIFRA_SETTING_HINT} Turning it off or on restarts each thread's engine when it is idle.`}>
        <Toggle
          label="Nifra in Nifra projects"
          checked={nifraOn(prefs)}
          onChange={(nifra) => {
            setPrefs({ nifra })
            restartEngines()
          }}
        />
      </Row>
      <Row id="run-setup" label="Setup" hint="Walks through your coding tools, plan limits, how much agents do on their own, and what to bring over from other tools. Nothing changes until you pick it.">
        <Button size="sm" variant="ghost" onClick={() => {
            set({ settings: false })
            setPrefs({ onboarded: false })
          }}>
          Run setup again
        </Button>
      </Row>
      <div data-setting="updates">
        <Updates />
      </div>
      <QuickChat />
      <PhoneAccess />
    </div>
  )
}

/** System Settings holds the answer, so it is read each time Settings opens. */
function LoginItemRow() {
  const words = useWords()
  const [status, setStatus] = useState<LoginItemStatus>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    getHost()
      .loginItem()
      .then(setStatus, () => setStatus("unavailable"))
  }, [])
  const hint =
    status === "unavailable"
      ? "Only the installed app can start at login."
      : status === "needs-approval"
        ? `Allow Runrail in ${words.settingsApp}, General, Login Items.`
        : (error ?? `At login, Runrail opens with no window and keeps schedules and runs going ${words.fromMenuBar}. With nothing to do, it quits after a minute.`)
  return (
    <Row id="login-item" label={`Start ${words.inMenuBar} at login`} hint={hint}>
      <Toggle
        label={`Start ${words.inMenuBar} at login`}
        checked={status === "on" || status === "needs-approval"}
        disabled={status === undefined || status === "unavailable"}
        onChange={(on) => {
          setError(undefined)
          getHost()
            .setLoginItem(on)
            .then(setStatus, (failure: unknown) => setError(toHostError(failure).message))
        }}
      />
    </Row>
  )
}

/** The helper that opens Runrail when work is due after Quit; launchd holds the answer. */
function WakeServiceRow() {
  const words = useWords()
  const [status, setStatus] = useState<WakeServiceStatus>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    getHost()
      .wakeService()
      .then(setStatus, () => setStatus("unavailable"))
  }, [])
  const hint =
    status === "unavailable"
      ? "Only the installed app can run after Quit."
      : status === "no-systemd"
        ? "Running after Quit needs systemd's user service manager, which this computer does not run."
        : (error ?? `After you quit, a small helper opens Runrail ${words.inMenuBar} when a schedule or a pull request trigger is due, or memory sources need their hourly sync. Runrail quits again once that work is done. ${words.wakeHelper}`)
  return (
    <Row id="wake-service" label="Run schedules after Quit" hint={hint}>
      <Toggle
        label="Run schedules after Quit"
        checked={status === "on"}
        disabled={status === undefined || status === "unavailable" || status === "no-systemd"}
        onChange={(on) => {
          setError(undefined)
          getHost()
            .setWakeService(on)
            .then(setStatus, (failure: unknown) => setError(toHostError(failure).message))
        }}
      />
    </Row>
  )
}

const TONE_PREVIEWS: readonly (readonly [Tone, string])[] = [
  ["done", "Finished"],
  ["attention", "Failed"],
  ["raise", "Needs approval"],
]

const NOTIFY_CHOICES: readonly (readonly [keyof NotifyOn, string])[] = [
  ["finished", "Finished"],
  ["failed", "Failed"],
  ["approvals", "Needs approval"],
]

function SystemNotificationsRow() {
  const words = useWords()
  const mode = useApp((state) => state.prefs.systemNotifications)
  const status = useNotifyStatus((state) => state.status)
  useEffect(() => {
    void readNotifyStatus().catch(() => undefined)
  }, [])
  const hint =
    status === undefined
      ? "Checking…"
      : !status.available
        ? words.notificationsUnavailable
        : status.permission === "denied"
          ? `Turned off for Runrail in ${words.settingsApp} > Notifications.`
          : "A click on one opens its thread. In the background posts only while Runrail is not the app in front."
  const test = async (): Promise<void> => {
    try {
      let next = status ?? (await readNotifyStatus())
      if (next.permission === "unknown") next = await requestNotifications()
      if (next.permission !== "granted") {
        toast("error", `${words.notifications} are turned off for Runrail. Turn them on in ${words.settingsApp} > Notifications.`)
        return
      }
      await getHost().notifySend({ threadId: "test", title: "Runrail", body: "Notifications are on.", sound: get().prefs.sounds })
    } catch (caught) {
      toast("error", toHostError(caught).message)
    }
  }
  return (
    <Row id="system-notifications" label={words.notifications} hint={hint}>
      <Button size="sm" variant="ghost" disabled={status?.available !== true} onClick={() => void test()}>
        Send a test
      </Button>
      <Segmented
        label={words.notifications}
        value={mode}
        onChange={(systemNotifications) => {
          setPrefs({ systemNotifications })
          if (systemNotifications !== "off" && status?.available === true && status.permission === "unknown") void requestNotifications().catch(() => undefined)
        }}
        options={[
          { value: "off", label: "Off" },
          { value: "background", label: "In background" },
          { value: "always", label: "Always" },
        ]}
      />
    </Row>
  )
}

function AgentSection() {
  const prefs = usePrefs()
  const words = useWords()
  const { editor } = useEditors()
  return (
    <div className="settings-page">
      <Head title="Agent" lead="How threads start, how they take your messages, and how their work shows. A thread's own model and permissions are set from its composer." />
      <h3>Starting a thread</h3>
      <Row id="worktree" label="New threads use a worktree" hint="Each thread gets its own branch and checkout, so parallel threads never touch each other's files.">
        <Toggle label="Worktree by default" checked={prefs.worktreeByDefault} onChange={(worktreeByDefault) => setPrefs({ worktreeByDefault })} />
      </Row>
      <Row
        id="thread-messages"
        label="Agents reach other threads"
        hint={`An agent can list your other threads, read one, and send one a message without asking. The message runs there with that thread's own permissions. A turn sends at most ${String(SENDS_PER_TURN)}, and threads messaging threads stop at ${String(MAX_CHAIN)} in a row.`}
      >
        <Segmented
          label="Agents reach other threads"
          value={prefs.threadMessages}
          onChange={(threadMessages) => {
            const restart = (threadMessages === "off") !== (prefs.threadMessages === "off")
            setPrefs({ threadMessages })
            // An engine starts with the thread tools or without them; a running turn finishes first.
            if (restart) restartEngines()
          }}
          options={[
            { value: "off", label: "Off" },
            { value: "project", label: "Same project" },
            { value: "all", label: "Any project" },
          ]}
        />
      </Row>
      <h3>Sending</h3>
      <Row id="send-key" label="Send with" hint="The other combination inserts a new line.">
        <Segmented
          label="Send key"
          value={prefs.sendKey}
          onChange={(sendKey) => setPrefs({ sendKey })}
          options={[
            { value: "enter", label: <Kbd keys="enter" />, title: `${words.returnKey} sends; Shift-${words.returnKey} adds a line` },
            { value: "mod-enter", label: <Kbd keys="mod+enter" />, title: `${words.command}-${words.returnKey} sends; ${words.returnKey} adds a line` },
          ]}
        />
      </Row>
      <Row
        id="follow-up"
        label="Sending while the agent works"
        hint={
          <>
            Queue holds the message until the turn ends. Steer hands it to the turn under way, which reads it at its next step; only threads on Runrail's own loop can be steered, so the others always queue. <Kbd keys={prefs.sendKey === "enter" ? "mod+enter" : "mod+alt+enter"} /> does the other one.
          </>
        }
      >
        <Segmented
          label="Sending while the agent works"
          value={prefs.followUp}
          onChange={(followUp) => setPrefs({ followUp })}
          options={[
            { value: "queue", label: "Queue" },
            { value: "steer", label: "Steer" },
          ]}
        />
      </Row>
      <Row id="continue-after-limit" label="Continue after a usage limit" hint="When a coding tool's plan or a provider stops a turn at its usage limit, the thread waits for the reset and goes on by itself, as if you had chosen that on the limit's card.">
        <Toggle label="Continue after a usage limit" checked={prefs.continueAfterLimit} onChange={(continueAfterLimit) => setPrefs({ continueAfterLimit })} />
      </Row>
      <Row id="paste-threshold" label="Fold long pastes" hint="A longer paste shows as one line in the composer and is still sent in full.">
        <select className="select" value={prefs.pasteThreshold} onChange={(event) => setPrefs({ pasteThreshold: Number(event.target.value) as PasteThreshold })} aria-label="Fold long pastes">
          {PASTE_THRESHOLDS.map((value) => (
            <option key={value} value={value}>
              {value === 0 ? "Never" : `Over ${value.toLocaleString("en-US")} characters`}
            </option>
          ))}
        </select>
      </Row>
      <h3>In the thread</h3>
      <Row id="show-reasoning" label="Reasoning" hint="The model's thinking, as a line you can open, open as it streams, or left out of the timeline.">
        <Segmented
          label="Reasoning"
          value={prefs.reasoning}
          onChange={(reasoning) => setPrefs({ reasoning })}
          options={[
            { value: "hidden", label: "Hidden" },
            { value: "folded", label: "Folded" },
            { value: "open", label: "Open" },
          ]}
        />
      </Row>
      <Row id="context-display" label="Context usage" hint="The ring shows the share used, colored green, yellow, or red as context fills. Show it always or once it passes 80%.">
        <Segmented
          label="Context usage"
          value={prefs.contextDisplay}
          onChange={(contextDisplay) => setPrefs({ contextDisplay })}
          options={[
            { value: "used", label: "Used" },
            { value: "near-full", label: "Near full" },
          ]}
        />
      </Row>
      <Row
        id="plan-limits"
        label="Show plan limits"
        hint="Shows how much of your Claude Code and Codex plans you have used. To find out, Runrail starts Claude Code and Codex signed in as you and asks for their usage: at start, when you press Refresh, and for Codex when you come back to the window. For Claude Code it first downloads the Claude Agent SDK from npm into Runrail's own folder, once. Turned off, nothing more is read."
      >
        <Toggle label="Show plan limits" checked={prefs.planLimits === "on"} onChange={setPlanLimits} />
      </Row>
      <Row id="file-links" label="Files named in answers open in" hint={`A file the agent names in an answer opens in Runrail's Files pane at its line, or in ${EDITOR_LABELS[editor]}. Right-click one for the other.`}>
        <Segmented
          label="Files named in answers open in"
          value={prefs.fileLinks}
          onChange={(fileLinks) => setPrefs({ fileLinks })}
          options={[
            { value: "app", label: "Runrail" },
            { value: "editor", label: EDITOR_LABELS[editor] },
          ]}
        />
      </Row>
      <Row id="diff-layout" label="Diff layout" hint="A file that was only added or only deleted always shows as one column.">
        <Segmented label="Diff layout" value={prefs.diffView} onChange={(diffView) => setPrefs({ diffView })} options={DIFF_LAYOUTS} />
      </Row>
      <h3>Commands and git</h3>
      <TerminalShellRow />
      <Row id="git-hooks" label="Run git hooks" hint="Commits and pushes from the Review pane run the repository's own hooks (lint, format, tests), as git does in a terminal.">
        <Toggle label="Run git hooks" checked={prefs.gitHooks} onChange={(gitHooks) => setPrefs({ gitHooks })} />
      </Row>
    </div>
  )
}

/** Languages macOS can dictate in; the list the system offers changes little between releases. */
const DICTATION_LANGUAGES = ["en-US", "en-GB", "en-AU", "en-IN", "es-ES", "es-MX", "fr-FR", "de-DE", "it-IT", "pt-BR", "pt-PT", "nl-NL", "sv-SE", "da-DK", "nb-NO", "fi-FI", "pl-PL", "tr-TR", "ru-RU", "uk-UA", "hi-IN", "ja-JP", "ko-KR", "zh-CN", "zh-TW", "yue-CN", "ar-SA", "he-IL", "th-TH", "vi-VN", "id-ID", "ms-MY"] as const

function languageName(tag: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" })
    return tag === "yue-CN" ? "Cantonese (China mainland)" : (names.of(tag) ?? tag)
  } catch {
    return tag
  }
}

/** The system's voices; WebKit lists them only after a moment. */
function useSystemVoices(): readonly SystemVoice[] {
  const [voices, setVoices] = useState(systemVoices)
  useEffect(() => {
    if (!readAloudAvailable()) return
    const refresh = (): void => setVoices(systemVoices())
    speechSynthesis.addEventListener("voiceschanged", refresh)
    const timer = setTimeout(refresh, 300)
    return () => {
      speechSynthesis.removeEventListener("voiceschanged", refresh)
      clearTimeout(timer)
    }
  }, [])
  return voices
}

function MicrophoneRow({ value, onChange }: { readonly value: string | undefined; readonly onChange: (device: string | undefined) => void }) {
  const words = useWords()
  const [devices, setDevices] = useState<readonly VoiceDevice[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    const read = (): void => {
      getHost()
        .voiceDevices()
        .then((list) => live && setDevices(list))
        .catch((caught: unknown) => live && setError(toHostError(caught).message))
    }
    read()
    // A microphone plugged in while Settings is open shows up when the window comes back.
    window.addEventListener("focus", read)
    return () => {
      live = false
      window.removeEventListener("focus", read)
    }
  }, [])
  const fallback = devices?.find((device) => device.default)
  const missing = value !== undefined && devices !== undefined && !devices.some((device) => device.id === value)
  return (
    <Row id="voice-microphone" label="Microphone" hint={error ?? (missing ? "That microphone is not connected; dictation uses the system's input until it is." : `Dictation listens on this input. The system's input is the one chosen in ${words.settingsApp} > Sound.`)}>
      <select className="select" value={value ?? ""} onChange={(event) => onChange(event.target.value.length === 0 ? undefined : event.target.value)} aria-label="Microphone" disabled={devices === undefined}>
        <option value="">System input{fallback === undefined ? "" : ` (${fallback.name})`}</option>
        {missing && <option value={value}>Not connected</option>}
        {devices?.map((device) => (
          <option key={device.id} value={device.id}>
            {device.name}
          </option>
        ))}
      </select>
    </Row>
  )
}

function WordsRow({ words, onChange }: { readonly words: readonly string[]; readonly onChange: (words: readonly string[]) => void }) {
  const [draft, setDraft] = useState(words.join("\n"))
  useEffect(() => setDraft(words.join("\n")), [words])
  const save = (): void => {
    const next = [...new Set(draft.split("\n").map((word) => word.trim()).filter((word) => word.length > 0 && word.length <= MAX_VOICE_WORD))].slice(0, MAX_VOICE_WORDS)
    if (next.join("\n") !== words.join("\n")) onChange(next)
  }
  return (
    <div className="setting-block" data-setting="voice-words">
      <div>
        <div className="setting-label">Words to recognize</div>
        <div className="setting-hint">Names, products, and terms the recognizer should expect, one per line (up to {MAX_VOICE_WORDS}).</div>
      </div>
      <textarea className="textarea mono" rows={4} value={draft} placeholder={"Runrail\nKubernetes\nPriya"} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={save} aria-label="Words to recognize" />
    </div>
  )
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000).toLocaleString("en-US")} MB`
}

/** Whisper models: download once, pick one, remove to free the space. */
function WhisperModels({ selected, onSelect }: { readonly selected: string | undefined; readonly onSelect: (model: string) => void }) {
  const [models, setModels] = useState<readonly VoiceModel[] | undefined>()
  const [progress, setProgress] = useState<Readonly<Record<string, ModelProgress>>>({})
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let live = true
    const host = getHost()
    const read = (): void => {
      host
        .voiceModels()
        .then((list) => live && setModels(list))
        .catch((caught: unknown) => live && setError(toHostError(caught).message))
    }
    read()
    const stop = host.onVoiceModel((update) => {
      if (!live) return
      setProgress((current) => ({ ...current, [update.id]: update }))
      if (update.state === "done" || update.state === "failed" || update.state === "cancelled") read()
      if (update.state === "failed") toast("error", `The model did not download: ${update.message ?? "unknown error"}`)
    })
    return () => {
      live = false
      stop()
    }
  }, [])
  // The first model downloaded becomes the one in use.
  useEffect(() => {
    if (models === undefined) return
    const usable = models.filter((model) => model.installed)
    if (usable.length > 0 && !usable.some((model) => model.id === selected)) onSelect(usable[0]?.id ?? "")
  }, [models, selected, onSelect])
  const run = (work: Promise<unknown>): void => {
    work.catch((caught: unknown) => toast("error", toHostError(caught).message))
  }
  return (
    <div className="setting-block" data-setting="voice-models">
      <div>
        <div className="setting-label">Whisper models</div>
        <div className="setting-hint">Downloaded once from Hugging Face (ggerganov/whisper.cpp) and checked against a fixed SHA-256 before use. Larger models are more accurate and slower; English models are better at English.</div>
      </div>
      {error !== undefined ? (
        <div className="setting-hint is-error">{error}</div>
      ) : models === undefined ? (
        <div className="pane-loading">
          <Spinner size={12} /> Reading models…
        </div>
      ) : (
        <ul className="model-list">
          {models.map((model) => {
            const update = progress[model.id]
            const downloading = model.downloading || update?.state === "downloading" || update?.state === "verifying"
            const share = update?.state === "downloading" && update.total !== undefined && update.total > 0 ? Math.min(1, (update.received ?? 0) / update.total) : undefined
            return (
              <li key={model.id} className={cx("model-row", selected === model.id && model.installed && "is-selected")}>
                <label className="model-pick">
                  <input type="radio" name="whisper-model" checked={selected === model.id && model.installed} disabled={!model.installed} onChange={() => onSelect(model.id)} />
                  <span className="model-name">{model.label}</span>
                  <span className="model-size">{megabytes(model.size)}</span>
                </label>
                {downloading ? (
                  <span className="model-progress">
                    <span className="progress-bar" aria-label={`Downloading ${model.label}`}>
                      <span className="progress-fill" style={{ width: `${String(Math.round((share ?? 0) * 100))}%` }} />
                    </span>
                    <span className="model-size">{update?.state === "verifying" ? "Checking…" : `${String(Math.round((share ?? 0) * 100))}%`}</span>
                    <Button size="sm" variant="ghost" onClick={() => run(getHost().voiceModelCancel(model.id))}>
                      Cancel
                    </Button>
                  </span>
                ) : model.installed ? (
                  <Button size="sm" variant="ghost" onClick={() => run(getHost().voiceModelRemove(model.id).then(setModels))}>
                    Remove
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => run(getHost().voiceModelDownload(model.id).then(() => setModels((list) => list?.map((item) => (item.id === model.id ? { ...item, downloading: true } : item)))))}>
                    Download
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function VoiceSection() {
  const words = useWords()
  const voice = useApp((state) => state.prefs.voice)
  const platform = useApp((state) => state.platform)
  const engine = voiceEngine(voice.engine, platform)
  const speaking = useVoice((state) => state.speaking === "voice-sample")
  const voices = useSystemVoices()
  const setVoice = (patch: Partial<VoicePrefs>): void => setPrefs({ voice: { ...get().prefs.voice, ...patch } })
  const language = voice.language ?? navigator.language
  const base = language.split("-")[0]?.toLowerCase() ?? ""
  const matching = voices.filter((item) => item.lang.toLowerCase().startsWith(base)).sort((left, right) => left.name.localeCompare(right.name))
  const canDictate = dictationAvailable()
  const canRead = readAloudAvailable()
  const native = hostListens()
  return (
    <div className="settings-page">
      <Head
        title="Voice"
        lead="Talk to the agent and hear its answers. Audio is never recorded or kept: it goes to the recognizer while you speak and is gone when the words are in the composer."
      />
      <h3>Dictation</h3>
      <Row
        id="voice-dictation"
        label="Dictation"
        hint={
          canDictate ? (
            <>
              A microphone beside the send button. <Kbd keys="mod+shift+m" /> starts and stops it; Escape stops it.{words.micPermission === undefined ? "" : ` ${words.micPermission}`}
            </>
          ) : (
            "This window has no speech recognition."
          )
        }
      >
        <Toggle label="Dictation" checked={voice.dictation && canDictate} disabled={!canDictate} onChange={(dictation) => setVoice({ dictation })} />
      </Row>
      {native && (
        <Row
          id="voice-engine"
          label="Recognition"
          hint={
            engine === "whisper"
              ? `Whisper runs on this ${words.computer} with a model you download once. Nothing leaves the ${words.computer}, and it works offline. The words appear when you stop speaking.`
              : "Apple's recognizer shows words as you speak. Depending on the language and your Mac, Apple may process the audio on its servers unless you keep it on this Mac below."
          }
        >
          {words.mac ? (
            <Segmented
              label="Recognition"
              value={voice.engine}
              onChange={(engine) => setVoice({ engine })}
              options={[
                { value: "apple", label: "Apple" },
                { value: "whisper", label: "Whisper" },
              ]}
            />
          ) : (
            <span className="setting-value">Whisper</span>
          )}
        </Row>
      )}
      {native && engine === "apple" && (
        <Row id="voice-on-device" label="Keep speech on this Mac" hint="macOS recognizes on this Mac only and works offline. Needs the language's on-device model, added under System Settings > Keyboard > Dictation.">
          <Toggle label="Keep speech on this Mac" checked={voice.onDevice} onChange={(onDevice) => setVoice({ onDevice })} />
        </Row>
      )}
      {native && engine === "whisper" && <WhisperModels selected={voice.model} onSelect={(model) => setVoice({ model })} />}
      <Row id="voice-language" label="Language" hint="The language you speak, for dictation and for reading answers aloud.">
        <select className="select" value={voice.language ?? ""} onChange={(event) => setVoice(event.target.value.length === 0 ? { language: undefined } : { language: event.target.value })} aria-label="Language">
          <option value="">Same as the system ({languageName(navigator.language)})</option>
          {DICTATION_LANGUAGES.map((tag) => (
            <option key={tag} value={tag}>
              {languageName(tag)}
            </option>
          ))}
        </select>
      </Row>
      <Row id="voice-auto-send" label="Send when you stop talking" hint="Otherwise the words wait in the composer for you to read, change, and send.">
        <Toggle label="Send when you stop talking" checked={voice.autoSend} onChange={(autoSend) => setVoice({ autoSend })} />
      </Row>
      <Row id="voice-sounds" label="Listening tones" hint="A soft tone when listening starts and stops.">
        <Toggle label="Listening tones" checked={voice.sounds} onChange={(sounds) => setVoice({ sounds })} />
      </Row>
      {native ? (
        <MicrophoneRow value={voice.device} onChange={(device) => setVoice(device === undefined ? { device: undefined } : { device })} />
      ) : (
        <Row id="voice-microphone" label="Microphone" hint={`Dictation listens on the input chosen in ${words.settingsApp} > Sound.`}>
          <span className="setting-value">System input</span>
        </Row>
      )}
      {native && <WordsRow words={voice.words} onChange={(words) => setVoice({ words })} />}
      <h3>Reading aloud</h3>
      <Row id="voice-read-aloud" label="Read answers aloud" hint="Each finished answer in the thread on screen is read out. Any answer can be read from its Read aloud button.">
        <Toggle label="Read answers aloud" checked={voice.readAloud && canRead} disabled={!canRead} onChange={(readAloud) => setVoice({ readAloud })} />
      </Row>
      <Row id="voice-voice" label="Reading voice" hint={`Voices on this ${words.computer} for ${languageName(language)}.${words.moreVoices === undefined ? "" : ` ${words.moreVoices}`}`}>
        <select className="select" value={voice.voiceId ?? ""} onChange={(event) => setVoice(event.target.value.length === 0 ? { voiceId: undefined } : { voiceId: event.target.value })} aria-label="Reading voice" disabled={!canRead}>
          <option value="">System default</option>
          {voice.voiceId !== undefined && !matching.some((item) => item.id === voice.voiceId) && <option value={voice.voiceId}>{voices.find((item) => item.id === voice.voiceId)?.name ?? "A voice for another language"}</option>}
          {matching.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.lang})
            </option>
          ))}
        </select>
      </Row>
      <Row id="voice-rate" label="Reading speed">
        <Button size="sm" variant="ghost" disabled={!canRead} onClick={() => speak("This is how answers will sound when they are read aloud.", "voice-sample")}>
          {speaking ? "Playing…" : "Play a sample"}
        </Button>
        <select className="select" value={voice.rate} onChange={(event) => setVoice({ rate: Number(event.target.value) })} aria-label="Reading speed" disabled={!canRead}>
          {VOICE_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate === 1 ? "Normal" : `${String(rate)}×`}
            </option>
          ))}
        </select>
      </Row>
      <h3>Talk mode</h3>
      <Row
        id="voice-talk"
        label="Talk mode"
        hint={
          <>
            In a thread, <AudioLines size={12} className="inline-icon" /> beside the microphone goes back and forth by voice: speak, it sends when you pause, reads the answer, and listens again. Escape or the button ends it, and so does leaving the thread. Approvals still wait for you.
          </>
        }
      >
        <span className="setting-value">{canDictate && canRead ? "In the composer" : "Not available here"}</span>
      </Row>
    </div>
  )
}

function TerminalShellRow() {
  const words = useWords()
  const shell = useApp((state) => state.prefs.terminalShell)
  const [shells, setShells] = useState<readonly string[]>([])
  useEffect(() => {
    let live = true
    getHost()
      .shellsList()
      .then((list) => live && setShells(list))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  const choose = (value: string): void => {
    setPrefs({ terminalShell: value === "" ? undefined : value })
    // Idle threads restart now; a running one waits for its turn to end.
    restartEngines()
  }
  return (
    <Row id="terminal-shell" label="Terminal shell" hint={`The shell a thread's terminal opens. Only the login shells this ${words.computer} lists in /etc/shells.`}>
      <select className="select" value={shell ?? ""} onChange={(event) => choose(event.target.value)} aria-label="Terminal shell">
        <option value="">Your login shell</option>
        {shells.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
        {shell !== undefined && !shells.includes(shell) && <option value={shell}>{shell}</option>}
      </select>
    </Row>
  )
}

/** The project Settings speaks about when a section is per project: the open one, else the first. */
function useSettingsProject(): { readonly id: string; readonly name: string; readonly path: string } | undefined {
  return useApp(useShallow((state) => {
    const project = state.projects.find((item) => item.id === (state.layout.activeProjectId ?? state.projects[0]?.id))
    return project === undefined ? undefined : { id: project.id, name: project.name, path: project.path }
  }))
}

/** Text boxes holding changes not saved yet; leaving Settings asks first. */
const unsavedEditors = new Set<string>()

/** A text box with Save and Discard that only saves on request, and other tools' text to start from. */
function TextEditor({ id, label, hint, value, max, placeholder, saving = false, onSave, extra, sources = [] }: { readonly id: string; readonly label: string; readonly hint: ReactNode; readonly value: string; readonly max: number; readonly placeholder: string; readonly saving?: boolean; readonly onSave: (text: string) => void; readonly extra?: ReactNode; readonly sources?: readonly FoundInstructions[] }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const changed = draft !== value
  useEffect(() => {
    if (changed) unsavedEditors.add(id)
    else unsavedEditors.delete(id)
    return () => void unsavedEditors.delete(id)
  }, [changed, id])
  return (
    <div className="setting-block" data-setting={id}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        <div className="setting-hint">{hint}</div>
      </div>
      <textarea
        className="textarea instructions-editor"
        value={draft}
        maxLength={max}
        rows={12}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "s" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (changed) onSave(draft)
          }
        }}
      />
      <div className="instructions-foot">
        <span className="instructions-count">{draft.length.toLocaleString()} / {max.toLocaleString()}</span>
        {sources.length > 0 && (
          <Menu
            align="start"
            side="top"
            width={320}
            items={[
              { heading: "Add the text from", id: "heading" },
              ...sources.map((source) => ({
                id: source.place,
                label: OTHER_TOOL_LABELS[source.tool],
                hint: source.place,
                onSelect: () => setDraft((current) => withImported(current, source.text).slice(0, max)),
              })),
            ]}
            trigger={({ toggle, ref, open }) => (
              <Button ref={ref} size="sm" variant="ghost" icon={<Download size={12} />} className={cx(open && "is-active")} onClick={toggle}>
                Import from…
              </Button>
            )}
          />
        )}
        {extra}
        <span className="instructions-spacer" />
        <Button size="sm" variant="ghost" disabled={!changed || saving} onClick={() => setDraft(value)}>
          Discard
        </Button>
        <Button size="sm" variant="primary" disabled={!changed} loading={saving} kbd="mod+s" onClick={() => onSave(draft)}>
          Save
        </Button>
      </div>
    </div>
  )
}

/**
 * One editor for the two places instructions live, as Codex, Claude Code, and Pi keep them too:
 * text every project gets (Runrail keeps it), and the open project's own AGENTS.md.
 */
function InstructionsSection() {
  const saved = useApp((state) => state.prefs.instructions ?? "")
  const project = useSettingsProject()
  const [scope, setScope] = useState<"all" | "project">("all")
  const [found, setFound] = useState<readonly FoundInstructions[]>([])
  useEffect(() => {
    let live = true
    getHost()
      .otherToolsScan(project?.path)
      .then((result) => live && setFound(result.instructions))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [project?.path])
  const shown = project === undefined ? "all" : scope
  return (
    <div className="settings-page">
      <Head title="Instructions" lead="What the agent should always know: conventions, commands to use, things to leave alone. Plain text or Markdown." />
      <Row
        id="instructions-scope"
        label="Applies to"
        hint={shown === "all" ? "Every thread in every project starts with these, on Runrail's own loop and on Claude Code and Codex." : `Only threads in ${project?.name ?? "this project"}. They come after the instructions for all projects.`}
      >
        <Segmented
          label="Applies to"
          value={shown}
          disabled={project === undefined}
          onChange={setScope}
          options={[
            { value: "all", label: "All projects" },
            { value: "project", label: project === undefined ? "This project" : `Only ${project.name}`, title: project === undefined ? "Open a project first" : `Saved as AGENTS.md in ${project.name}` },
          ]}
        />
      </Row>
      {shown === "all" || project === undefined ? (
        <TextEditor
          key="all"
          id="global-instructions"
          label="Instructions for all projects"
          hint="Kept in Runrail. Running agents pick up a change once their turn ends."
          value={saved}
          max={MAX_INSTRUCTIONS}
          placeholder={"Prefer small, reviewable changes.\nRun the tests before saying a change works."}
          sources={found.filter((item) => item.scope === "global")}
          onSave={(text) => {
            setPrefs({ instructions: text })
            restartEngines()
            toast("success", "Instructions saved")
          }}
        />
      ) : (
        <ProjectInstructionsEditor key={project.id} project={project} sources={found.filter((item) => item.scope === "project")} />
      )}
    </div>
  )
}

function ProjectInstructionsEditor({ project, sources }: { readonly project: { readonly id: string; readonly name: string; readonly path: string }; readonly sources: readonly FoundInstructions[] }) {
  const words = useWords()
  const [file, setFile] = useState<ProjectInstructions | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let live = true
    getHost()
      .instructionsRead(project.path)
      .then((value) => live && setFile(value))
      .catch((caught: unknown) => live && setError(toHostError(caught).message))
    return () => {
      live = false
    }
  }, [project.path])
  if (error !== undefined && file === undefined) return <p className="setting-hint is-error" data-setting="project-instructions">AGENTS.md in {project.name}: {error}</p>
  if (file === undefined)
    return (
      <div className="pane-loading" data-setting="project-instructions">
        <Spinner size={12} /> Reading AGENTS.md…
      </div>
    )
  return (
    <TextEditor
      id="project-instructions"
      label={`Instructions for ${project.name}`}
      hint={
        <>
          Saved as <code>AGENTS.md</code> in the project folder, where Codex and other agents read it too.{file.exists ? "" : " The file does not exist yet; saving creates it."}
          {file.claudeFile && <> The project also has <code>CLAUDE.md</code>; the agent reads both.</>}
          {error !== undefined && <span className="is-error"> {error}</span>}
        </>
      }
      value={file.text}
      max={MAX_PROJECT_INSTRUCTIONS}
      placeholder={"## Commands\n- Test: bun test\n\n## Conventions\n- ..."}
      saving={saving}
      sources={sources}
      extra={
        file.exists ? (
          <Button size="sm" variant="ghost" icon={<FolderOpen size={12} />} onClick={() => void reveal(project.path, "AGENTS.md")}>
            {words.showIn}
          </Button>
        ) : undefined
      }
      onSave={(text) => {
        setSaving(true)
        setError(undefined)
        getHost()
          .instructionsWrite(project.path, text)
          .then((value) => {
            setFile(value)
            restartEngines(project.id)
            toast("success", `AGENTS.md saved in ${project.name}`)
          })
          .catch((caught: unknown) => setError(toHostError(caught).message))
          .finally(() => setSaving(false))
      }}
    />
  )
}

function SkillsSection() {
  const project = useSettingsProject()
  const revision = useImportRevision((state) => state.skills)
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState(0)
  const importFolder = (): void => {
    if (project === undefined) return
    setImporting(true)
    getHost()
      .skillImport(project.path)
      .then((skill) => {
        if (skill === null) return
        toast("success", `${skill.name} copied into ${skill.path}.`)
        setImported((count) => count + 1)
      })
      .catch((caught: unknown) => toast("error", `Could not import the skill: ${toHostError(caught).message}`))
      .finally(() => setImporting(false))
  }
  return (
    <div className="settings-page" data-setting="skills">
      <div className="settings-head-row">
        <div>
          <Head title="Skills" lead={project === undefined ? "Open a project to see its skills." : `For ${project.name}, and the ones every project shares. Switch one off to keep it out of this project.`} />
        </div>
        {project !== undefined && (
          <div className="settings-head-actions">
            <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => openDialog({ kind: "other-tools", section: "skills", projectId: project.id })} data-setting="skill-from-tools" title="Skills set up in Claude Code, Codex, opencode, and Pi">
              From other tools…
            </Button>
            <Button size="sm" icon={<FolderOpen size={13} />} loading={importing} onClick={importFolder} data-setting="skill-import" title="Copy a folder with a SKILL.md into this project's .agents/skills">
              Import a folder…
            </Button>
          </div>
        )}
      </div>
      {project !== undefined && <ProjectSkills projectId={project.id} reloadSignal={imported + revision} />}
    </div>
  )
}

function Subagents() {
  const project = useSettingsProject()
  const catalog = useCatalog(project?.id)
  return (
    <div className="settings-page" data-setting="subagents">
      <Head title="Subagents" lead="Specialists the main agent can hand part of a task to. Each runs with its own context and reports back. Claude Code threads use these; Runrail's own loop does not hand work to subagents yet." />
      {project === undefined ? <p className="setting-hint">Open a project to see its subagents.</p> : <SubagentEditor project={project} />}
      {project !== undefined && catalog.agents.length > 0 && <h3>Offered by the engine</h3>}
      {project !== undefined && catalog.agents.length > 0 && (
        <ul className="settings-list">
          {catalog.agents.map((agent) => (
            <li key={agent.id} className="settings-list-row">
              <Bot size={14} className="muted" />
              <span className="settings-list-text">
                <span className="settings-list-title">{agent.role ?? agent.id}</span>
                {agent.description !== undefined && <span className="settings-list-hint">{agent.description}</span>}
              </span>
              {agent.capabilities !== undefined && agent.capabilities.length > 0 && <span className="settings-list-meta">{agent.capabilities.length === 1 ? "1 capability" : `${String(agent.capabilities.length)} capabilities`}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Projects() {
  const words = useWords()
  const projects = useApp((state) => state.projects)
  const threads = useApp((state) => state.threads)
  const hosts = useCodeHostRecords()
  // Opening the page reads each folder's remotes again, so a remote added on disk shows up.
  useEffect(() => {
    void readAllProjectGit(30_000)
  }, [])
  return (
    <div className="settings-page" data-setting="projects">
      <div className="settings-head-row">
        <div>
          <Head title="Projects" lead="Folders Runrail works in, and the git host each is on. Removing one takes it and its threads out of the sidebar; nothing on disk is deleted." />
        </div>
        <Button size="sm" icon={<Plus size={13} />} onClick={() => void pickProject()}>
          Add project
        </Button>
      </div>
      <p className="setting-hint" data-setting="project-git">
        Each project shows the git host its folder is on. Confirm a host Runrail only guessed, and choose whether pull requests on GitHub use your own GitHub CLI sign-in.
      </p>
      <p className="setting-hint" data-setting="browser-sign-ins">
        Browser previews keep no cookies. A project can keep its sign-ins instead: they are saved sealed, with the key in your {words.keychain}, and the next preview of that project starts signed in. Agents using that project's browser tabs act signed in too.
      </p>
      {projects.length === 0 ? (
        <p className="setting-hint">No projects yet.</p>
      ) : (
        <ul className="settings-list">
          {projects.map((project) => {
            const count = threads.filter((thread) => thread.projectId === project.id && thread.archived !== true).length
            return (
              <li key={project.id} className="settings-list-row project-row" data-setting={`project-${project.id}`}>
                <FolderOpen size={14} className="muted" />
                <span className="settings-list-text">
                  <span className="settings-list-title">{project.name}</span>
                  <span className="settings-list-hint" title={project.remote === undefined ? project.path : `${project.remote.host}:${project.path}`}>
                    {project.remote === undefined ? compactPath(project.path) : `${project.remote.host}:${project.path}`} · {count === 0 ? "no threads yet" : plural(count, "thread")}
                  </span>
                  <ProjectGitLine project={project} records={hosts.records} onChanged={hosts.reload} />
                  {/* Related folders and browser sign-ins are this Mac's; a remote project has neither. */}
                  {project.remote === undefined && <ProjectFolders project={project} />}
                  {project.remote === undefined && <ProjectSignIns project={project} />}
                </span>
                {project.remote === undefined && (
                  <IconButton label={words.reveal} size="sm" onClick={() => void reveal(project.path)}>
                    <FolderOpen size={13} />
                  </IconButton>
                )}
                <IconButton
                  label={`Remove ${project.name}`}
                  size="sm"
                  onClick={() =>
                    confirmAction({
                      title: `Remove ${project.name}?`,
                      body: "The project and its threads leave the sidebar. Files on disk and engine history are not deleted.",
                      confirm: "Remove",
                      danger: true,
                      onConfirm: () => void closeProject(project.id),
                    })
                  }
                >
                  <Trash size={13} />
                </IconButton>
              </li>
            )
          })}
        </ul>
      )}
      {hosts.problem !== undefined && <p className="setting-hint is-error">{hosts.problem}</p>}
      <RemoteMachines />
    </div>
  )
}

function ImportSection() {
  const project = useSettingsProject()
  return (
    <div className="settings-page">
      <Head title="Import" lead="Continue work you started in another tool. Runrail copies the transcript into a new thread and leaves the original untouched." />
      <Row id="import-sessions" label="Import sessions" hint={project === undefined ? "Open a project first; sessions are listed per folder." : `Sessions other coding tools recorded for ${project.name}.`}>
        <Button size="sm" disabled={project === undefined} onClick={() => project !== undefined && openDialog({ kind: "import", projectId: project.id })}>
          Choose sessions…
        </Button>
      </Row>
      <h3 data-setting="import-from-tools">Skills, MCP servers, and subagents from other tools</h3>
      <p className="setting-hint">Claude Code, Codex, Cursor, Gemini CLI, opencode, and Pi keep their own. Pick what to bring over; tokens and other secret values are never copied.</p>
      <div className="settings-head-actions is-wrapping">
        {(["skills", "servers", "agents"] as const).map((section) => (
          <Button key={section} size="sm" icon={<Download size={13} />} disabled={project === undefined} title={project === undefined ? "Open a project first" : undefined} onClick={() => project !== undefined && openDialog({ kind: "other-tools", section, projectId: project.id })}>
            {section === "skills" ? "Skills…" : section === "servers" ? "MCP servers…" : "Subagents…"}
          </Button>
        ))}
        <Button size="sm" variant="ghost" icon={<FileText size={13} />} onClick={() => set({ settings: "instructions" })}>
          Instructions
        </Button>
      </div>
      <h3 data-setting="import-providers">Providers from other tools</h3>
      <p className="setting-hint">Providers Codex, Pi, and opencode are set up with. Runrail reads their addresses and variable names only; a key written in their files is never copied.</p>
      <ImportProviders />
    </div>
  )
}

function Updates() {
  const prefs = usePrefs()
  const version = useApp((state) => state.hostVersion)
  const { supported, status } = useUpdates()
  if (!supported) {
    return (
      <Row label="Updates" hint="This build does not update itself. Release builds check a signed update feed and verify every download before installing.">
        <span className="setting-value">{version.length === 0 ? "Development build" : `Version ${version}`}</span>
      </Row>
    )
  }
  const update = status.phase === "idle" || status.phase === "current" ? undefined : status.update
  const busy = status.phase === "checking" || status.phase === "installing"
  return (
    <>
      <Row label="Check for updates automatically" hint="Checks a signed feed at launch and every few hours. Nothing is downloaded until you choose to install.">
        <Toggle label="Check for updates automatically" checked={prefs.checkUpdates} onChange={(checkUpdates) => setPrefs({ checkUpdates })} />
      </Row>
      <Row label="Version" hint={updateHint(status, version)}>
        <Button size="sm" loading={status.phase === "checking"} disabled={busy} onClick={() => void checkForUpdates()}>
          Check now
        </Button>
      </Row>
      {update !== undefined && (
        <div className="update-card" role="status">
          <div className="update-card-head">
            <Download size={14} aria-hidden />
            <strong>Runrail {update.version}</strong>
            <span className="update-card-meta">
              You have {update.current}
              {update.date === undefined ? "" : ` · released ${update.date.slice(0, 10)}`}
            </span>
          </div>
          {update.notes !== undefined && <pre className="update-notes">{update.notes}</pre>}
          {status.phase === "failed" && (
            <div className="update-error">
              <CircleAlert size={13} aria-hidden /> {status.message}
            </div>
          )}
          <div className="update-actions">
            <span className="setting-hint">Running threads stop when the app restarts. Their history is kept.</span>
            <Button variant="primary" size="sm" loading={status.phase === "installing"} disabled={busy} onClick={() => void installUpdate()}>
              {status.phase === "installing" ? "Installing" : status.phase === "failed" ? "Try again" : "Install and restart"}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

function updateHint(status: ReturnType<typeof useUpdates.getState>["status"], version: string): ReactNode {
  const current = version.length === 0 ? "This build" : `Version ${version}`
  switch (status.phase) {
    case "checking":
      return `${current}. Checking for updates.`
    case "current":
      return `${current} is the latest. Checked ${relativeTime(status.checkedAt)}.`
    case "available":
      return `${current}. An update is ready to install.`
    case "installing":
      return "Downloading and verifying the update. The app restarts when it is installed."
    case "failed":
      return status.update === undefined ? (
        <span className="setting-hint is-error">
          <CircleAlert size={12} aria-hidden /> Could not check for updates: {status.message}
        </span>
      ) : (
        `${current}. The update did not install.`
      )
    default:
      return `${current}.`
  }
}

function Models() {
  const prefs = usePrefs()
  const project = useApp((state) => state.projects.find((item) => item.id === (state.layout.activeProjectId ?? state.projects[0]?.id)))
  const catalog = useCatalog(project?.id)
  const start = startSelection(prefs)
  const known = catalog.loading || catalog.connectionsError !== undefined ? undefined : catalog.connections
  // Only tools the app can start; ones it cannot (no launch command yet) would only be noise here.
  // With connection settings, the providers list above offers every tool found here instead.
  const tools = catalog.tools !== undefined ? [] : catalog.harnesses.filter((tool) => listedTool(tool.id) && (TOOL_BACKENDS as readonly string[]).includes(tool.id))
  return (
    <div className="settings-page">
      <Head title="Models" lead="What a new thread starts with, and the connections models come through. Every thread changes its model and reasoning from the model menu in the composer." />
      <Row
        id="start-on"
        label="Default model and reasoning"
        hint={catalog.tools === undefined ? "What a new thread starts on, and how hard it thinks. Follows the model you last picked for a new thread. Claude Code, Codex, GitHub Copilot, and Pi run with the login they already have." : "What a new thread starts on, and how hard it thinks. Follows the model you last picked for a new thread; adding a provider never changes it."}
      >
        <ModelPicker
          className="is-field"
          side="bottom"
          align="end"
          catalog={catalog}
          value={{ ...start, thinking: prefs.defaultThinking }}
          problem={selectionProblem(start, known, prefs.developer, known === undefined ? undefined : catalog.tools)}
          busy={false}
          onPick={setStartDefault}
          onThinking={(defaultThinking: Thinking) => setPrefs({ defaultThinking })}
        />
      </Row>

      <div className="settings-embed" data-setting="connections">
        <ConnectionsPage />
      </div>

      {tools.length > 0 && (
        <>
          <h3 data-setting="coding-tools">Coding tools on this computer</h3>
          <ul className="provider-list">
            {tools.map((tool) => {
              // The model menu offers only the tools the app knows how to start.
              const offered = (TOOL_BACKENDS as readonly string[]).includes(tool.id)
              // What the engine found when it asked the tool about itself. Tools the app cannot start are listed as they are.
              const state: ToolState | "other" = offered ? toolState(catalog.harnesses, tool.id as BackendId) : "other"
              const usable = state === "ready" || state === "unknown"
              // A tool that was found but never said whether someone is signed in is not called ready.
              const unasked = state === "ready" && catalog.harnesses.find((item) => item.id === tool.id)?.signedIn === undefined
              const found = typeof tool.version === "string" && tool.version.length > 0 ? `Version ${tool.version}. ` : ""
              return (
                <li key={tool.id} className="provider-row">
                  <span className={cx("provider-state", usable ? "is-ok" : state === "signed-out" ? "is-warn" : "is-off")}>
                    {usable ? <Check size={12} /> : state === "signed-out" ? <CircleAlert size={12} /> : <Minus size={12} />}
                    {unasked ? "Installed" : TOOL_STATE_TEXT[state]}
                  </span>
                  <span className="provider-name">{offered ? BACKEND_LABELS[tool.id as BackendId] : (tool.name ?? tool.id)}</span>
                  <span className="provider-hint">
                    {state === "other"
                      ? "Needs a launch command, which the app cannot set yet."
                      : state === "missing"
                        ? "Not found on this computer."
                        : state === "signed-out"
                          ? "Sign in with the tool in a terminal, then refresh."
                          : unasked
                            ? `${found}Its login is not checked here.`
                            : `${found}Runs with its own login.`}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * The engine also reports its own loop, the recorded-session player, and the generic PTY adapter
 * for any command that prints JSON lines. None is a tool someone installs, so none is listed.
 */
const NOT_TOOLS: ReadonlySet<string> = new Set(["native", "replay", "pty"])

export function listedTool(id: string): boolean {
  return !NOT_TOOLS.has(id)
}

const TOOL_STATE_TEXT: Record<ToolState | "other", string> = {
  ready: "Ready",
  unknown: "In the model menu",
  missing: "Not installed",
  "signed-out": "Not signed in",
  other: "Not in the app",
}

const PERMISSION_TEXT: Record<Access, string> = {
  plan: "The agent reads the project and proposes steps. It changes nothing until you leave Plan.",
  ask: "The agent reads freely and asks before every edit, command, or network call.",
  "auto-edit": "Edits inside the workspace apply without asking. Commands and network calls still ask.",
  auto: "Claude Code's auto mode or Codex's Approve for me: the tool's own reviewer approves routine actions and stops risky ones. Other tools, and Claude Code where its auto mode is unavailable, ask instead.",
  full: "Everything runs without asking. Use only for workspaces you can throw away.",
}

function Permissions() {
  const prefs = usePrefs()
  return (
    <div className="settings-page">
      <Head title="Permissions" lead="Where new threads start. Change it per thread from the composer toolbar, or with Shift-Tab while typing." />
      <div className="choice-list" role="radiogroup" aria-label="Default permissions" data-setting="default-permissions">
        {ACCESS_ORDER.map((id) => {
          const active = accessOf(prefs.defaultMode, prefs.defaultPermission) === id
          return (
            <button key={id} type="button" role="radio" aria-checked={active} className={cx("choice", active && "is-active", id === "full" && "is-danger")} onClick={() => {
                const choose = (): void => setPrefs(id === "plan" ? { defaultMode: "plan" } : { defaultMode: "agent", defaultPermission: id })
                if (id !== "full" || active) choose()
                else confirmAction({ title: "Start every new thread with full access?", body: PERMISSION_TEXT.full, confirm: "Use full access", danger: true, onConfirm: choose })
              }}>
              <span className="choice-radio" aria-hidden />
              <span className="choice-text">
                <span className="choice-label">{ACCESS_LABELS[id]}</span>
                <span className="choice-hint">{PERMISSION_TEXT[id]}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="callout">
        <ShieldCheck size={14} />
        <span>Approvals gate what the agent may do, but the agent still runs as your user. Local processes are not a sandbox for untrusted code; use a worktree or a container for risky work.</span>
      </div>
      <ComputerSettings />
    </div>
  )
}

function Shortcuts() {
  const sendKey = useApp((state) => state.prefs.sendKey)
  const composer = [
    { keys: sendKey === "enter" ? "enter" : "mod+enter", label: "Send, or queue while the agent works" },
    { keys: "shift+enter", label: "New line" },
    { keys: sendKey === "enter" ? "mod+enter" : "mod+alt+enter", label: "Steer the running turn" },
    { keys: "escape", label: "Stop the agent" },
    { keys: "@", label: "Mention a file" },
    { keys: "/", label: "Slash commands" },
    { keys: "shift+tab", label: "Switch between Ask, Auto-edit, and Plan" },
  ]
  const groups = ["General", "Go to", "Layout", "Threads"] as const
  return (
    <div className="settings-page" data-setting="shortcuts">
      <Head title="Shortcuts" />
      {groups.map((group) => (
        <section key={group}>
          <h3>{group}</h3>
          <dl className="shortcut-list">
            {SHORTCUTS.filter((item) => item.group === group).map((item) => (
              <div key={item.id} className="shortcut-row">
                <dt>{item.label}</dt>
                <dd>
                  <Kbd keys={item.keys} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section>
        <h3>Composer</h3>
        <dl className="shortcut-list">
          {composer.map((item) => (
            <div key={item.label} className="shortcut-row">
              <dt>{item.label}</dt>
              <dd>
                <Kbd keys={item.keys} />
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}

function Developer() {
  const prefs = usePrefs()
  const { hostVersion, platform, startupMs, activeThreadId, projectId } = useApp(
    useShallow((state) => ({ hostVersion: state.hostVersion, platform: state.platform, startupMs: state.startupMs, activeThreadId: state.layout.activeThreadId, projectId: state.layout.activeProjectId ?? state.projects[0]?.id })),
  )
  const [serviceContract, setServiceContract] = useState<Contract | undefined>(() => (projectId === undefined ? undefined : projectContract(projectId)))
  const runtime = useApp((state) => (activeThreadId === undefined ? undefined : state.runtime[activeThreadId]))
  const diagnostics = useDiagnostics()
  const [engines, setEngines] = useState<{ list?: readonly EngineInfo[]; error?: string; loading: boolean }>({ loading: true })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let live = true
    setEngines((current) => ({ ...current, loading: true }))
    getHost()
      .engineList()
      .then((list) => live && setEngines({ list, loading: false }))
      .catch((error: unknown) => live && setEngines({ error: toHostError(error).code, loading: false }))
    return () => {
      live = false
    }
  }, [nonce])

  // Without an open thread the project's own engine answers; both speak the same contract.
  useEffect(() => {
    if (projectId === undefined) return
    let live = true
    projectCapability(projectId, "control")
      .then(() => live && setServiceContract(projectContract(projectId)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [projectId])

  const contract = runtime?.contract ?? serviceContract
  const contractSource = runtime?.contract !== undefined ? " (open thread)" : serviceContract !== undefined ? " (project engine)" : ""
  const capabilities = Object.entries(contract?.capabilities ?? {}).sort(([left], [right]) => left.localeCompare(right))
  const counters = Object.entries(diagnostics.counters).sort(([left], [right]) => left.localeCompare(right))
  const report = JSON.stringify(
    {
      host: { kind: getHost().kind, version: hostVersion, platform, ...(startupMs === undefined ? {} : { startupMs }) },
      contract: contract === undefined ? undefined : { protocol: contract.protocol, apiVersion: contract.apiVersion, runrailVersion: contract.runrailVersion },
      engines: engines.list?.map((engine) => ({ state: engine.state, backend: engine.backend, instance: engine.instance })),
      counters: diagnostics.counters,
      recentErrors: diagnostics.lastCodes.map((entry) => entry.code),
      threadOpens: diagnostics.opens.map(({ backend, totalMs, items, steps }) => ({ backend, totalMs, items, steps: Object.fromEntries(steps) })),
      historyDrawn: diagnostics.paints.map(({ kind, ms, items }) => ({ kind, ms, items })),
      uptimeMs: Date.now() - diagnostics.startedAt,
    },
    null,
    2,
  )

  return (
    <div className="settings-page">
      <Head title="Advanced" lead="For trying Runrail without a model, and for reporting a problem. Nothing here changes how your threads run unless you turn it on." />
      <Row id="developer-mode" label="Developer mode" hint="Adds the tools below to the app. Turn it off to hide them again; threads you started with them keep working.">
        <Toggle label="Developer mode" checked={prefs.developer} onChange={(developer) => setPrefs({ developer })} />
      </Row>
      <ul className="advanced-list" aria-label="What developer mode adds">
        {DEVELOPER_ADDS.map((item) => (
          <li key={item.title} className={cx(!prefs.developer && "is-off")}>
            <span className="advanced-title">{item.title}</span>
            <span className="advanced-text">{item.text}</span>
          </li>
        ))}
      </ul>
      {prefs.developer && (
        <Row label="New threads start on" hint="Replay plays a recorded session back. Runrail with no model picked uses the test model. Both cost nothing.">
          <select className="select" value={prefs.defaultBackend} onChange={(event) => setPrefs({ defaultBackend: event.target.value as BackendId })} aria-label="New threads start on">
            {BACKENDS.map((id) => (
              <option key={id} value={id}>
                {BACKEND_LABELS[id]}
              </option>
            ))}
          </select>
        </Row>
      )}

      <h3 data-setting="diagnostics">Troubleshooting</h3>
      <Row label="Details for a bug report" hint="Versions, engine states, and counts of error codes. No prompts, file paths, keys, or model output are ever recorded here.">
        <CopyButton text={report} label="Copy details" />
      </Row>
      <details className="advanced-details">
        <summary>Show the details</summary>
      <h3>Host</h3>
      <dl className="kv">
        <dt>Shell</dt>
        <dd>{getHost().kind === "tauri" ? "Desktop" : "Browser preview"}</dd>
        <dt>Version</dt>
        <dd>{hostVersion === "" ? "-" : hostVersion}</dd>
        <dt>Platform</dt>
        <dd>{platform}</dd>
        <dt>This launch</dt>
        <dd title="From the moment the app's process started to saved state on screen">{startupMs === undefined ? "-" : `Ready in ${String(startupMs)} ms`}</dd>
        <dt>Counting since</dt>
        <dd>{relativeTime(diagnostics.startedAt)}</dd>
      </dl>

      <h3>Thread opens</h3>
      {diagnostics.opens.length === 0 ? (
        <p className="setting-hint">No thread has started its engine since the app opened.</p>
      ) : (
        <dl className="kv">
          {diagnostics.opens.map((open, index) => (
            <Fragment key={`${String(open.at)}-${String(index)}`}>
              <dt>{BACKEND_LABELS[open.backend as BackendId] ?? open.backend}</dt>
              <dd title={open.steps.map(([step, ms]) => `${step} ${String(ms)} ms`).join("\n")}>
                {`${String(open.totalMs)} ms, ${String(open.items)} items: ${open.steps.map(([step, ms]) => `${step} ${String(ms)}`).join(" · ")}`}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {diagnostics.paints.length > 0 && (
        <dl className="kv">
          {diagnostics.paints.map((paint, index) => (
            <Fragment key={`${String(paint.at)}-${String(index)}`}>
              <dt>{paint.kind === "first" ? "History drawn, first open" : "History drawn, revisit"}</dt>
              <dd>{`${String(paint.ms)} ms from the click, ${String(paint.items)} items`}</dd>
            </Fragment>
          ))}
        </dl>
      )}

      <h3>Engine contract{contractSource}</h3>
      {contract === undefined ? (
        <p className="setting-hint">{projectId === undefined ? "Open a project to inspect its engine contract." : activeThreadId !== undefined && runtimeOf(activeThreadId).engine === "ready" ? "The engine did not report a contract." : "Waiting for the project engine."}</p>
      ) : (
        <>
          <dl className="kv">
            <dt>Runrail</dt>
            <dd>{contract.runrailVersion ?? "-"}</dd>
            <dt>API</dt>
            <dd>{contract.apiVersion ?? "-"}</dd>
            <dt>Protocol</dt>
            <dd>{contract.protocol ?? "-"}</dd>
          </dl>
          {capabilities.length > 0 && (
            <div className="capability-grid">
              {capabilities.map(([name, state]) => (
                <span key={name} className={cx("capability", `is-${state}`)} title={`${name}: ${CAPABILITY_TEXT[state]}`}>
                  {state === "available" ? <Check size={10} /> : state === "configurable" ? <CircleAlert size={10} /> : <Minus size={10} />}
                  {name}
                  {state !== "available" && <span className="capability-state">{CAPABILITY_TEXT[state]}</span>}
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <h3>
        Engines
        <IconButton label="Refresh engines" size="sm" onClick={() => setNonce((value) => value + 1)} disabled={engines.loading}>
          {engines.loading ? <Spinner size={11} /> : <RotateCcw size={11} />}
        </IconButton>
      </h3>
      {engines.error !== undefined ? (
        <p className="setting-hint is-error">Could not list engines ({engines.error}).</p>
      ) : engines.list === undefined ? null : engines.list.length === 0 ? (
        <p className="setting-hint">No engines are running.</p>
      ) : (
        <table className="diag-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Backend</th>
              <th>State</th>
              <th>Instance</th>
            </tr>
          </thead>
          <tbody>
            {engines.list.map((engine) => (
              <tr key={engine.engineId}>
                <td>{engine.engineId.startsWith("svc-") ? "Project service" : "Thread"}</td>
                <td>{BACKEND_LABELS[engine.backend as BackendId] ?? engine.backend}</td>
                <td className={cx(engine.state === "exited" && "is-muted")}>{engine.state}</td>
                <td>{engine.instance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>
        Counters
        <IconButton label="Reset counters" size="sm" onClick={resetDiagnostics}>
          <RotateCcw size={11} />
        </IconButton>
      </h3>
      {counters.length === 0 ? (
        <p className="setting-hint">Nothing recorded yet.</p>
      ) : (
        <table className="diag-table">
          <tbody>
            {counters.map(([code, count]) => (
              <tr key={code}>
                <td className="mono">{code}</td>
                <td className="num">{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {diagnostics.lastCodes.length > 0 && (
        <>
          <h3>Recent error codes</h3>
          <ul className="diag-codes">
            {diagnostics.lastCodes.map((entry, index) => (
              <li key={`${entry.code}-${String(entry.at)}-${String(index)}`}>
                <code>{entry.code}</code>
                <span className="muted">{relativeTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      </details>
    </div>
  )
}

/** What turning on developer mode adds, one line each, so the switch says what it does. */
const DEVELOPER_ADDS: readonly { readonly title: string; readonly text: string }[] = [
  { title: "Test model", text: "A scripted stand-in that answers without any provider, for trying the app. It is not an AI and does not read your code." },
  { title: "Recorded sessions", text: "Play a saved session back step by step instead of calling a model." },
  { title: "Share record", text: "A summary of a thread with its status and timings and none of its messages, to attach to a bug report." },
  { title: "Engine names", text: "The model menu and thread details show the engine's own names for what a thread runs on." },
]

const CAPABILITY_TEXT: Record<CapabilityState, string> = { available: "available", configurable: "needs setup", unavailable: "unavailable" }
