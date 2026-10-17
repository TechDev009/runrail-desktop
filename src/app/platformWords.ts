import { get, useApp } from "./store"

/**
 * Words that name the computer and its own apps and places. macOS keeps its own
 * words; Linux desktops name their file manager, settings and keyring differently, so Linux gets
 * plain ones. A test keeps the macOS words out of every other string.
 */
export interface PlatformWords {
  readonly mac: boolean
  /** After "this" or "the": "Mac" or "computer". */
  readonly computer: string
  /** "Reveal in Finder" or "Show in Files". */
  readonly reveal: string
  /** "Show in Finder" or "Show in Files". */
  readonly showIn: string
  /** After "from": "Finder" or "the file manager". */
  readonly fileManager: string
  /** As a label or to start a sentence: "macOS notifications" or "System notifications". */
  readonly notifications: string
  /** Inside a sentence: "macOS notifications" or "system notifications". */
  readonly notificationsInText: string
  /** Why notifications cannot be posted at all. */
  readonly notificationsUnavailable: string
  /** Where a setting lives: "System Settings" or "your desktop's settings". */
  readonly settingsApp: string
  /** Where Runrail runs while its window is closed: "in the menu bar" or "in the background". */
  readonly inMenuBar: string
  readonly fromMenuBar: string
  /** Where Runrail's icon is when it has one: "the menu bar" or "the tray". */
  readonly menuBar: string
  /** Where keys are kept, after "the" or "your": "Keychain" or "keyring". */
  readonly keychain: string
  /** Who keeps the helper that runs after Quit. */
  readonly wakeHelper: string
  readonly quitKeys: string
  /** Key names: "Option" or "Alt", "Command" or "Ctrl", "Return" or "Enter". */
  readonly option: string
  readonly command: string
  readonly returnKey: string
  /** The keys a global shortcut is made with. */
  readonly modifierKeys: string
  /** How to bring Tailscale up when it is installed but not connected. */
  readonly tailscaleConnect: string
  /** What the system asks the first time dictation listens, where it asks. */
  readonly micPermission?: string
  /** Where more reading voices come from, where the system has a place for them. */
  readonly moreVoices?: string
}

const MAC: PlatformWords = {
  mac: true,
  computer: "Mac",
  reveal: "Reveal in Finder",
  showIn: "Show in Finder",
  fileManager: "Finder",
  notifications: "macOS notifications",
  notificationsInText: "macOS notifications",
  notificationsUnavailable: "Only the installed app can post macOS notifications. This build shows notes in the window instead.",
  settingsApp: "System Settings",
  inMenuBar: "in the menu bar",
  fromMenuBar: "from the menu bar",
  menuBar: "the menu bar",
  keychain: "Keychain",
  wakeHelper: "macOS lists the helper under Login Items.",
  quitKeys: "Cmd+Q",
  option: "Option",
  command: "Command",
  returnKey: "Return",
  modifierKeys: "Option, Command, Control or Shift",
  tailscaleConnect: "Connect it from its menu bar icon.",
  micPermission: "The first time, macOS asks to allow the microphone and speech recognition.",
  moreVoices: "More can be added in System Settings > Accessibility > Spoken Content.",
}

const LINUX: PlatformWords = {
  mac: false,
  computer: "computer",
  reveal: "Show in Files",
  showIn: "Show in Files",
  fileManager: "the file manager",
  notifications: "System notifications",
  notificationsInText: "system notifications",
  notificationsUnavailable: "No notification service answered on this desktop, so Runrail shows notes in the window instead.",
  settingsApp: "your desktop's settings",
  inMenuBar: "in the background",
  fromMenuBar: "in the background",
  menuBar: "the tray",
  keychain: "keyring",
  wakeHelper: "It runs as a systemd user service.",
  quitKeys: "Ctrl+Q",
  option: "Alt",
  command: "Ctrl",
  returnKey: "Enter",
  modifierKeys: "Ctrl, Alt, Super or Shift",
  tailscaleConnect: "Connect it with sudo tailscale up in a terminal.",
}

/** macOS words everywhere but Linux, so the browser preview's stand-in reads as the Mac app does. */
export function platformWords(platform: string | undefined): PlatformWords {
  return platform === "linux" ? LINUX : MAC
}

export function words(): PlatformWords {
  return platformWords(get().platform)
}

export function useWords(): PlatformWords {
  return platformWords(useApp((state) => state.platform))
}
