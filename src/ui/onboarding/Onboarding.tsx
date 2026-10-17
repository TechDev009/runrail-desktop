import { Check, Download, Info, Play, Plug, Settings } from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { connectModel } from "../../app/actions"
import { listConnections, onConnectionsChanged } from "../../app/connections"
import { detectTools, listConnectionSettings, type ToolConnection, type ToolId } from "../../app/connectionSettings"
import { applyTools, bringOver, connectionFor, finishOnboarding, hasSetup, initialPicks, missingTools, offersLimits, scanSetup, toolChoices, type OnboardingStep, type SetupFound, type ToolChoice } from "../../app/onboarding"
import { OTHER_TOOL_LABELS } from "../../app/otherTools"
import { BACKEND_LABELS, type PermissionPreset } from "../../app/persist"
import type { CodingTool } from "../../app/picker"
import { setPlanLimits } from "../../app/planUsage"
import { get, setPrefs, toast } from "../../app/store"
import { toHostError, type OtherTool } from "../../host"
import { plural } from "../../lib/format"
import { Button, cx, Spinner, Toggle } from "../common"

const MONOGRAMS: Readonly<Record<ToolId, string>> = { "claude-code": "CC", codex: "Cx", copilot: "GH", opencode: "OC", gemini: "Gm", goose: "Gs", pi: "Pi" }

const ACCESS: readonly { readonly value: PermissionPreset; readonly label: string; readonly detail: string }[] = [
  { value: "ask", label: "Ask", detail: "Asks before every command and file change" },
  { value: "auto-edit", label: "Auto-edit", detail: "Changes files on its own, asks before commands" },
  { value: "auto", label: "Auto", detail: "Claude Code's auto mode and Codex's own reviewer decide; other tools ask" },
  { value: "full", label: "Full access", detail: "Runs commands and changes files without asking" },
]

function listed(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`
}

/** First run, over the whole window: the coding tools, plan limits, how much agents do alone, and what to bring over. */
export function Onboarding() {
  const [step, setStep] = useState<OnboardingStep>("welcome")
  const [found, setFound] = useState<readonly CodingTool[] | undefined>()
  const [connections, setConnections] = useState<readonly ToolConnection[]>([])
  const [on, setOn] = useState<ReadonlySet<ToolId> | undefined>()
  const [models, setModels] = useState<number | undefined>()
  const [setup, setSetup] = useState<SetupFound | undefined>()
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [access, setAccess] = useState<PermissionPreset>(() => get().prefs.defaultPermission)
  const [busy, setBusy] = useState(false)

  const readTools = useCallback((refresh: boolean): void => {
    void Promise.all([detectTools(refresh), listConnectionSettings().catch(() => undefined), listConnections().catch(() => [])]).then(([tools, listing, providers]) => {
      setFound(tools)
      setConnections(listing?.tools ?? [])
      setModels(providers.length)
    })
  }, [])

  useEffect(() => {
    readTools(false)
    void scanSetup().then(
      (value) => {
        setSetup(value)
        setPicked(initialPicks(value))
      },
      () => setSetup({ servers: [], instructions: [], skills: 0, agents: 0 }),
    )
    // A sign-in finished in the connect dialog or a terminal shows when the person comes back.
    const again = (): void => readTools(true)
    window.addEventListener("focus", again)
    const stop = onConnectionsChanged(again)
    return () => {
      window.removeEventListener("focus", again)
      stop()
    }
  }, [readTools])

  const choices = useMemo(() => (found === undefined ? [] : toolChoices(found, connections)), [found, connections])
  // The person's picks win over what the tools report, once there are any.
  const chosen = useMemo(() => on ?? new Set(choices.filter((choice) => choice.on).map((choice) => choice.tool)), [on, choices])
  const steps = useMemo((): readonly OnboardingStep[] => ["welcome", "tools", ...(offersLimits(choices, chosen) ? (["limits"] as const) : []), "access", ...(hasSetup(setup) ? (["setup"] as const) : [])], [choices, chosen, setup])
  const index = Math.max(0, steps.indexOf(step))
  const last = index === steps.length - 1

  const next = (): void => {
    if (last) finishOnboarding()
    else setStep(steps[index + 1]!)
  }
  const back = (): void => setStep(steps[Math.max(0, index - 1)]!)
  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await work()
    } catch (caught) {
      const failure = toHostError(caught)
      if (failure.code !== "MCP_DECLINED") toast("error", failure.message)
      setBusy(false)
      return
    }
    setBusy(false)
    next()
  }

  const toggle = (tool: ToolId, value: boolean): void => {
    const set = new Set(chosen)
    if (value) set.add(tool)
    else set.delete(tool)
    setOn(set)
  }
  const signIn = (choice: ToolChoice): void => {
    toggle(choice.tool, true)
    void connectionFor(choice).then(
      (connection) => connectModel({ connectionId: connection.id }),
      (caught: unknown) => toast("error", toHostError(caught).message),
    )
  }

  let body: ReactNode
  let actions: ReactNode
  switch (step) {
    case "welcome":
      body = (
        <>
          <img className="onboarding-icon" src="/runrail-icon.png" width={52} height={52} alt="" />
          <h1>Welcome to Runrail</h1>
          <p className="onboarding-sub">Run Claude Code, Codex, and other coding agents, or Runrail's own, on this computer. Every change lands in a diff you review before it's committed.</p>
          <p className="onboarding-quiet">Setup takes about a minute. Everything here can be changed later in Settings.</p>
        </>
      )
      actions = (
        <Button variant="primary" autoFocus onClick={next}>
          Get started
        </Button>
      )
      break
    case "tools": {
      const missing = found === undefined ? [] : missingTools(found)
      body = (
        <>
          <h1>Your coding tools</h1>
          <p className="onboarding-sub">Runrail runs them with the logins they already have, so they use those accounts' plans or keys. Turn off any you don't use, and Runrail won't start it.</p>
          {found === undefined ? (
            <div className="onboarding-loading" role="status">
              <Spinner size={13} /> Looking for coding tools on this computer
            </div>
          ) : (
            <div className="onboarding-list">
              {choices.map((choice) => (
                <div key={choice.tool} className="onboarding-item">
                  <span className={cx("onboarding-mono", `tool-${choice.tool}`)} aria-hidden>
                    {MONOGRAMS[choice.tool]}
                  </span>
                  <div className="onboarding-grow">
                    <div className="onboarding-name">{BACKEND_LABELS[choice.tool]}</div>
                    {choice.version !== undefined && <div className="onboarding-meta">{choice.version}</div>}
                  </div>
                  {choice.signedIn === true && <span className="onboarding-badge is-ok">Signed in</span>}
                  {choice.signedIn === false && (
                    <Button size="sm" onClick={() => signIn(choice)}>
                      Sign in
                    </Button>
                  )}
                  <Toggle checked={chosen.has(choice.tool)} onChange={(value) => toggle(choice.tool, value)} label={`Use ${BACKEND_LABELS[choice.tool]}`} />
                </div>
              ))}
              {choices.length === 0 && <div className="onboarding-item onboarding-meta">No coding tools found. Runrail's own agent works with any model you connect.</div>}
              {missing.length > 0 && <div className="onboarding-item onboarding-more">Not installed: {listed(missing.map((tool) => BACKEND_LABELS[tool]))}</div>}
            </div>
          )}
          <div className="onboarding-list">
            <div className="onboarding-item">
              <img className="onboarding-mono-img" src="/runrail-icon.png" width={26} height={26} alt="" />
              <div className="onboarding-grow">
                <div className="onboarding-name">Runrail's own agent</div>
                <div className="onboarding-meta">{models !== undefined && models > 0 ? `${plural(models, "connection")} · add another any time` : "Any model with an API key, or one running on this computer"}</div>
              </div>
              <Button size="sm" icon={<Plug size={13} />} onClick={() => connectModel()}>
                {models !== undefined && models > 0 ? "Add" : "Connect a model"}
              </Button>
            </div>
          </div>
          <Note icon={<Info size={14} />}>A Claude plan works through Claude Code. Runrail's own agent needs an Anthropic API key for Claude. Runrail never sees a login, and turning a tool off doesn't sign you out.</Note>
        </>
      )
      actions = (
        <Button variant="primary" loading={busy} disabled={found === undefined} onClick={() => void run(() => applyTools(choices, chosen))}>
          Continue
        </Button>
      )
      break
    }
    case "limits": {
      const tools = choices.filter((choice) => (choice.tool === "claude-code" || choice.tool === "codex") && chosen.has(choice.tool)).map((choice) => BACKEND_LABELS[choice.tool])
      body = (
        <>
          <h1>Show your plan limits?</h1>
          <p className="onboarding-sub">Runrail can show how much of your plans you've used, and warn you before a limit stops a thread.</p>
          <div className="onboarding-list">
            {tools.map((name) => (
              <div key={name} className="onboarding-item">
                <span className="onboarding-ring" aria-hidden />
                <div className="onboarding-grow">
                  <div className="onboarding-name">{name}</div>
                  <div className="onboarding-meta">Its 5-hour and weekly limits, and when each resets</div>
                </div>
              </div>
            ))}
          </div>
          <div className="onboarding-group">What it does</div>
          <Note icon={<Play size={14} />}>Starts {listed(tools)}, signed in as you, asks for {tools.length === 1 ? "its" : "their"} usage, and closes {tools.length === 1 ? "it" : "them"}: at start, when you press Refresh{tools.includes(BACKEND_LABELS.codex) ? ", and for Codex when you come back to the window" : ""}.</Note>
          {tools.includes(BACKEND_LABELS["claude-code"]) && <Note icon={<Download size={14} />}>For Claude Code, it first downloads the Claude Agent SDK from npm into Runrail's own folder, once.</Note>}
          <Note icon={<Settings size={14} />}>Turn it off any time in Settings, Agent.</Note>
        </>
      )
      actions = (
        <>
          <Button
            onClick={() => {
              setPlanLimits(false)
              next()
            }}
          >
            Not now
          </Button>
          <Button
            variant="primary"
            autoFocus
            onClick={() => {
              setPlanLimits(true)
              next()
            }}
          >
            Show limits
          </Button>
        </>
      )
      break
    }
    case "access":
      body = (
        <>
          <h1>How much should agents do on their own?</h1>
          <p className="onboarding-sub">This is where new threads start. Change it in any thread from the composer.</p>
          <div className="onboarding-list" role="radiogroup" aria-label="Where new threads start">
            {ACCESS.map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={access === option.value} className={cx("onboarding-item", "onboarding-choice", access === option.value && "is-selected")} onClick={() => setAccess(option.value)}>
                <span className="onboarding-radio" aria-hidden />
                <div className="onboarding-grow">
                  <div className="onboarding-name">
                    {option.label}
                    {option.value === "auto" && <span className="onboarding-badge">Recommended</span>}
                  </div>
                  <div className="onboarding-meta">{option.detail}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="onboarding-cards">
            <div>
              <b>Review before commit</b>Every change shows as a diff to stage, comment on, and commit.
            </div>
            <div>
              <b>Plan first</b>Plan mode reads and plans, and changes nothing. Shift-Tab switches.
            </div>
          </div>
        </>
      )
      actions = (
        <Button
          variant="primary"
          autoFocus
          onClick={() => {
            setPrefs({ defaultPermission: access })
            next()
          }}
        >
          {last ? "Done" : "Continue"}
        </Button>
      )
      break
    case "setup": {
      const have = setup ?? { servers: [], instructions: [], skills: 0, agents: 0 }
      const tools = [...new Set<OtherTool>([...have.servers.map((item) => item.tool), ...have.instructions.map((item) => item.tool)])]
      const count = have.servers.filter((item) => item.server !== undefined && picked.has(item.key)).length + have.instructions.filter((item) => picked.has(item.key)).length
      const pick = (key: string): void =>
        setPicked((current) => {
          const set = new Set(current)
          if (set.has(key)) set.delete(key)
          else set.add(key)
          return set
        })
      const extra = [have.skills > 0 ? plural(have.skills, "skill") : undefined, have.agents > 0 ? plural(have.agents, "subagent") : undefined].filter((item): item is string => item !== undefined)
      body = (
        <>
          <h1>Bring your setup</h1>
          <p className="onboarding-sub">Runrail found these in the other coding tools on this computer. Pick what to bring over; those tools stay as they are.</p>
          {tools.map((tool) => (
            <div key={tool}>
              <div className="onboarding-group">{OTHER_TOOL_LABELS[tool]}</div>
              <div className="onboarding-list">
                {have.servers
                  .filter((item) => item.tool === tool)
                  .map((item) => (
                    <Pick key={item.key} checked={item.server !== undefined && picked.has(item.key)} disabled={item.server === undefined} onChange={() => pick(item.key)} name={item.name} meta={`MCP server · ${item.blocked ?? item.detail}`} />
                  ))}
                {have.instructions
                  .filter((item) => item.tool === tool)
                  .map((item) => (
                    <Pick key={item.key} checked={picked.has(item.key)} onChange={() => pick(item.key)} name="Your instructions" meta={`${item.place} · ${OTHER_TOOL_LABELS[tool]} already reads it; this adds it to every thread`} />
                  ))}
              </div>
            </div>
          ))}
          {extra.length > 0 && <Note icon={<Info size={14} />}>Also found {listed(extra)}. They're copied into a project, so add them from its settings once it's open.</Note>}
        </>
      )
      actions = (
        <Button
          variant="primary"
          loading={busy}
          onClick={() =>
            void run(async () => {
              if (count === 0) return
              const done = await bringOver(have, picked)
              const parts = [done.servers > 0 ? plural(done.servers, "MCP server") : undefined, done.instructions > 0 ? "your instructions" : undefined].filter((item): item is string => item !== undefined)
              if (parts.length > 0) toast("success", `Brought over ${listed(parts)}.`)
            })
          }
        >
          {count === 0 ? "Done" : `Bring over ${plural(count, "item")}`}
        </Button>
      )
      break
    }
  }

  return (
    <main className="onboarding" aria-label="Set up Runrail">
      <div className="onboarding-top" data-tauri-drag-region>
        <div className="onboarding-steps" aria-label={`Step ${String(index + 1)} of ${String(steps.length)}`}>
          {steps.map((item, at) => (
            <i key={item} className={cx(at < index && "is-done", at === index && "is-now")} />
          ))}
        </div>
      </div>
      <div className="onboarding-scroll">
        <div key={step} className="onboarding-col">
          {body}
        </div>
      </div>
      <div className="onboarding-foot">
        <Button variant="ghost" className="onboarding-skip" onClick={finishOnboarding}>
          {last ? "Skip" : "Skip setup"}
        </Button>
        {index > 0 && (
          <Button variant="ghost" onClick={back} disabled={busy}>
            Back
          </Button>
        )}
        {actions}
      </div>
    </main>
  )
}

function Note({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="onboarding-note">
      {icon}
      <span>{children}</span>
    </div>
  )
}

function Pick({ checked, disabled, onChange, name, meta }: { readonly checked: boolean; readonly disabled?: boolean; readonly onChange: () => void; readonly name: string; readonly meta: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} className={cx("onboarding-item", "onboarding-choice", disabled === true && "is-disabled")} onClick={onChange}>
      <span className={cx("onboarding-check", checked && "is-on")} aria-hidden>
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <div className="onboarding-grow">
        <div className="onboarding-name">{name}</div>
        <div className="onboarding-meta">{meta}</div>
      </div>
    </button>
  )
}
