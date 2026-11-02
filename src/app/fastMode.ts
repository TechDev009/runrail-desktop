import type { BackendId } from "../host/types"

export function supportsFastMode(backend: BackendId): boolean {
  return backend === "codex" || backend === "claude-code"
}
