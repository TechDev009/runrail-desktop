import { create } from "zustand"
import { getHost, toHostError, type RemoteCheck, type RemoteMachine } from "../host"

/**
 * Remote machines: the host keeps the list and shows anything new to the person
 * before saving it; this mirrors it for the screens that pick one.
 */

interface RemotesState {
  readonly machines: readonly RemoteMachine[]
  readonly loaded: boolean
  readonly error?: string
}

export const useRemotes = create<RemotesState>()(() => ({ machines: [], loaded: false }))

export async function loadRemotes(): Promise<void> {
  try {
    useRemotes.setState({ machines: await getHost().remoteList(), loaded: true, error: undefined })
  } catch (error) {
    useRemotes.setState({ loaded: true, error: toHostError(error).message })
  }
}

/** Saves a machine; the host asks the person first. The saved machine, or undefined if they declined. */
export async function saveRemote(machine: { readonly id?: string; readonly host: string; readonly engine?: string }): Promise<RemoteMachine | undefined> {
  const engine = machine.engine?.trim()
  const machines = await getHost().remoteSave({ ...(machine.id === undefined ? {} : { id: machine.id }), host: machine.host.trim(), ...(engine === undefined || engine.length === 0 ? {} : { engine }) })
  useRemotes.setState({ machines, loaded: true })
  return machines.find((saved) => (machine.id === undefined ? saved.host === machine.host.trim() : saved.id === machine.id))
}

export async function removeRemote(id: string): Promise<void> {
  useRemotes.setState({ machines: await getHost().remoteRemove(id) })
}

export function checkRemote(id: string, folder?: string): Promise<RemoteCheck> {
  return getHost().remoteCheck(id, folder)
}

/** The last part of a remote path, for a project's name. */
export function remoteFolderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? path
}

/** An absolute path on the remote machine, as the host takes one. */
export function validRemotePath(path: string): boolean {
  return path.startsWith("/") && path.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(path)
}
