import { platformWords, words as currentWords, type PlatformWords } from "../../app/platformWords"
import type { SettingsSection } from "../../app/store"

/**
 * Every setting Settings shows, by section, so the search box can find a row by its label or by
 * the words someone might use for it. A row draws `data-setting` with its id; a test keeps the two
 * in step.
 */

export type PageSection = Exclude<SettingsSection, "connections">

export interface SettingEntry {
  readonly id: string
  readonly section: PageSection
  readonly label: string
  readonly keywords?: string
}

export const SECTION_LABELS: Readonly<Record<PageSection, string>> = {
  general: "General",
  ai: "Agent",
  voice: "Voice",
  instructions: "Instructions",
  mcp: "MCP servers",
  models: "Models",
  permissions: "Permissions",
  skills: "Skills",
  agents: "Subagents",
  projects: "Projects",
  import: "Import",
  shortcuts: "Shortcuts",
  developer: "Advanced",
}

/** Every row; a few labels name the computer, so they follow the platform. */
function index(words: PlatformWords): readonly SettingEntry[] {
  return [
    { id: "theme", section: "general", label: "Theme", keywords: "dark light system appearance mode" },
    { id: "palette", section: "general", label: "Palette", keywords: "color colour scheme flower japanese sakura yozakura cherry blossom ume plum fuji wisteria ajisai hydrangea tsubaki camellia matcha green tea pink" },
    { id: "accent", section: "general", label: "Accent", keywords: "color colour highlight" },
    { id: "text-size", section: "general", label: "Text size", keywords: "font size bigger smaller zoom" },
    { id: "glass", section: "general", label: "Translucent window", keywords: "glass vibrancy transparent sidebar blur frosted" },
    { id: "density", section: "general", label: "Density", keywords: "compact comfortable spacing" },
    { id: "thread-timestamps", section: "general", label: "Thread timestamps", keywords: "sidebar last message activity time timer date" },
    { id: "ui-font", section: "general", label: "Interface font", keywords: "font typeface rounded system sf pro" },
    { id: "code-font", section: "general", label: "Code font", keywords: "font monospace mono menlo monaco sf mono terminal" },
    { id: "editor", section: "general", label: "Open files in", keywords: "editor vs code cursor zed" },
    { id: "office-mode", section: "general", label: "Office mode", keywords: "office floor rooms people pixel desks game map" },
    { id: "office-open-on", section: "general", label: "Open on", keywords: "office floor list start launch default view" },
    { id: "learn-mode", section: "general", label: "Learn mode", keywords: "learn lessons teach explain beginner tutorial brief standard deep what is the agent doing" },
    { id: "lessons-seen", section: "general", label: "Lessons seen", keywords: "learn lessons reset show again seen" },
    { id: "game-layer", section: "general", label: "Game layer", keywords: "game xp level levels quests quest shift report points goals" },
    { id: "nifra", section: "general", label: "Nifra in Nifra projects", keywords: "nifra framework mcp tools check promotion authors starter turn off" },
    { id: "notifications", section: "general", label: "Notes in the window", keywords: "notifications alerts inbox finished approval toast" },
    { id: "system-notifications", section: "general", label: words.notifications, keywords: "notifications system banner notification center alerts background test" },
    { id: "notify-on", section: "general", label: "Notify about", keywords: "notifications finished failed approval which events" },
    { id: "motion", section: "general", label: "Reduce motion", keywords: "animation animations accessibility movement" },
    { id: "sounds", section: "general", label: "Sounds", keywords: "sound chime tone audio finished done approval alert raised hand" },
    { id: "sound-volume", section: "general", label: "Volume", keywords: "sound volume loud quiet level tone preview play" },
    { id: "quiet-minutes", section: "general", label: "Flag quiet threads after", keywords: "quiet stuck silent hang idle frozen waiting tray minutes threshold" },
    { id: "keep-awake", section: "general", label: `Keep the ${words.computer} awake while working`, keywords: "sleep caffeinate prevent sleep power battery" },
    { id: "keep-display-awake", section: "general", label: "Keep the display on too", keywords: "screen display sleep dim prevent" },
    { id: "login-item", section: "general", label: `Start ${words.inMenuBar} at login`, keywords: "login startup launch boot open at login background menu bar tray" },
    { id: "wake-service", section: "general", label: "Run schedules after Quit", keywords: "quit closed background schedule workflow helper launchd systemd wake run after quit" },
    { id: "confirm-quit", section: "general", label: "Ask before quitting while threads or runs go", keywords: "quit close confirm exit running warn workflow setup eval" },
    { id: "run-setup", section: "general", label: "Setup", keywords: "onboarding first run welcome tour start over walkthrough" },
    { id: "updates", section: "general", label: "Updates", keywords: "version upgrade release" },
    { id: "send-key", section: "ai", label: "Send with", keywords: "enter return keyboard submit" },
    { id: "continue-after-limit", section: "ai", label: "Continue after a usage limit", keywords: "rate limit quota reset wait resume weekly five hour plan" },
    { id: "follow-up", section: "ai", label: "Sending while the agent works", keywords: "queue steer follow-up follow up interrupt busy running enter" },
    { id: "show-reasoning", section: "ai", label: "Reasoning", keywords: "thinking thoughts show hide expand collapse detailed compact" },
    { id: "context-display", section: "ai", label: "Context usage", keywords: "context window ring tokens left used full hide near" },
    { id: "plan-limits", section: "ai", label: "Show plan limits", keywords: "usage quota percent rings weekly session five hour sdk npm" },
    { id: "file-links", section: "ai", label: "Files named in answers open in", keywords: "links link target file open editor runrail files pane" },
    { id: "paste-threshold", section: "ai", label: "Fold long pastes", keywords: "paste large clipboard collapse placeholder" },
    { id: "terminal-shell", section: "ai", label: "Terminal shell", keywords: "shell zsh bash fish command terminal" },
    { id: "worktree", section: "ai", label: "New threads use a worktree", keywords: "branch checkout parallel isolation" },
    { id: "thread-messages", section: "ai", label: "Agents reach other threads", keywords: "message send ask another thread agent to agent list read talk hand off" },
    { id: "diff-layout", section: "ai", label: "Diff layout", keywords: "unified split side by side review" },
    { id: "git-hooks", section: "ai", label: "Run git hooks", keywords: "commit push pre-commit lint" },
    { id: "voice-dictation", section: "voice", label: "Dictation", keywords: "voice microphone mic speech to text talk speak transcribe whisper" },
    { id: "voice-engine", section: "voice", label: "Recognition", keywords: "voice dictation apple whisper engine speech recognizer local offline" },
    { id: "voice-on-device", section: "voice", label: "Keep speech on this Mac", keywords: "voice on-device offline private local apple servers privacy" },
    { id: "voice-models", section: "voice", label: "Whisper models", keywords: "voice whisper model download local offline tiny base small large turbo" },
    { id: "voice-words", section: "voice", label: "Words to recognize", keywords: "voice dictation dictionary vocabulary names terms custom words" },
    { id: "voice-language", section: "voice", label: "Language", keywords: "voice dictation speech language chinese mandarin cantonese english hindi" },
    { id: "voice-auto-send", section: "voice", label: "Send when you stop talking", keywords: "voice dictation auto send silence pause hands free" },
    { id: "voice-sounds", section: "voice", label: "Listening tones", keywords: "voice dictation sound tone beep start stop" },
    { id: "voice-microphone", section: "voice", label: "Microphone", keywords: "voice input device mic sound" },
    { id: "voice-read-aloud", section: "voice", label: "Read answers aloud", keywords: "voice speech text to speech tts speak read out listen" },
    { id: "voice-voice", section: "voice", label: "Reading voice", keywords: "voice tts speaker system voice siri" },
    { id: "voice-rate", section: "voice", label: "Reading speed", keywords: "voice tts rate speed fast slow" },
    { id: "voice-talk", section: "voice", label: "Talk mode", keywords: "voice live conversation hands free talk speak listen loop" },
    { id: "global-instructions", section: "instructions", label: "Instructions for all projects", keywords: "system prompt rules conventions custom instructions global every import claude.md codex agents.md gemini opencode pi" },
    { id: "instructions-scope", section: "instructions", label: "Project instructions (AGENTS.md)", keywords: "agents.md claude.md repository rules conventions applies to this project" },
    { id: "mcp-servers", section: "mcp", label: "MCP servers", keywords: "model context protocol tools integrations github database server add" },
    { id: "mcp-import", section: "mcp", label: "MCP servers from other tools", keywords: "claude code claude desktop codex cursor gemini opencode import mcp.json config.toml" },
    { id: "start-on", section: "models", label: "Default model and reasoning", keywords: "start new threads provider thinking effort level" },
    { id: "connections", section: "models", label: "AI providers", keywords: "connections api key sign in subscription account login coding tools claude code codex copilot gemini goose opencode pi cli installed" },
    { id: "image-model", section: "models", label: "Image model", keywords: "picture image generation draw illustration gpt-image dall-e imagen flux openrouter make art" },
    { id: "default-permissions", section: "permissions", label: "Default permissions", keywords: "approval ask auto edit full access safety plan mode start new threads" },
    { id: "computer-use", section: "permissions", label: "Computer use", keywords: "apps mac screen recording accessibility click type screenshot allow control desktop linux x11 wayland share window portal" },
    { id: "browser-sign-ins", section: "projects", label: "Keep browser sign-ins", keywords: "cookies login session preview browser signed in remember forget clear" },
    { id: "computer-simulators", section: "permissions", label: "iOS simulators for agents", keywords: "simulator iphone ipad xcode idb simctl tap mobile app" },
    { id: "computer-emulators", section: "permissions", label: "Android emulators for agents", keywords: "android emulator adb avd pixel phone tap mobile app" },
    { id: "skills", section: "skills", label: "Skills", keywords: "instructions commands prompts" },
    { id: "skill-import", section: "skills", label: "Import a skill folder", keywords: "skill folder copy add SKILL.md" },
    { id: "skill-from-tools", section: "skills", label: "Skills from other tools", keywords: "claude code codex opencode pi agents skills import copy" },
    { id: "subagents", section: "agents", label: "Subagents", keywords: "agents delegate roles claude agents edit add reviewer" },
    { id: "subagent-import", section: "agents", label: "Subagents from other tools", keywords: "claude code opencode agents import copy" },
    { id: "projects", section: "projects", label: "Projects", keywords: "folders workspaces remove reveal" },
    { id: "quick-chat", section: "general", label: "Quick chat", keywords: "global shortcut hotkey option space spotlight ask anywhere screenshot window" },
    { id: "phone-access", section: "general", label: "Phone access", keywords: "phone mobile iphone android tailscale tailnet pair remote away" },
    { id: "remote-machines", section: "projects", label: "Remote machines", keywords: "ssh remote server machine host linux box cloud vm engine" },
    { id: "project-git", section: "projects", label: "Git host and GitHub CLI", keywords: "git hosts github gitlab bitbucket gh cli pull request remote origin server enterprise connect service" },
    { id: "import-sessions", section: "import", label: "Import sessions", keywords: "claude code codex pi transcript history continue" },
    { id: "import-providers", section: "import", label: "Providers from other tools", keywords: "import providers codex pi opencode config models connections" },
    { id: "import-from-tools", section: "import", label: "Skills, MCP servers, and subagents from other tools", keywords: "import claude code codex cursor gemini opencode pi skills mcp agents" },
    { id: "shortcuts", section: "shortcuts", label: "Keyboard shortcuts", keywords: "keys keymap hotkeys" },
    { id: "developer-mode", section: "developer", label: "Developer mode", keywords: "debug test model recorded session replay share record advanced" },
    { id: "diagnostics", section: "developer", label: "Troubleshooting details", keywords: "diagnostics bug report counters errors engines contract capabilities version" },
  ]
}

/** The ids and sections, the same on every platform. */
export const SETTINGS_INDEX = index(platformWords(undefined))

/** Entries whose label, section, or keywords hold every word typed, best (label) matches first. */
export function searchSettings(query: string, platform: PlatformWords = currentWords()): readonly SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return []
  const scored: { readonly entry: SettingEntry; readonly score: number }[] = []
  for (const entry of index(platform)) {
    const label = entry.label.toLowerCase()
    const haystack = `${label} ${SECTION_LABELS[entry.section].toLowerCase()} ${entry.keywords ?? ""}`
    if (!words.every((word) => haystack.includes(word))) continue
    scored.push({ entry, score: words.every((word) => label.includes(word)) ? (label.startsWith(words[0] ?? "") ? 0 : 1) : 2 })
  }
  return scored.sort((left, right) => left.score - right.score).map((item) => item.entry)
}
