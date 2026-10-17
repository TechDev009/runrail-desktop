import { CircleAlert, CircleCheck, Info, X } from "lucide-react"
import { dismissToast, useApp, type Toast } from "../../app/store"
import { useTray } from "../../app/triage"
import { cx } from "../common"

/** Top-right toasts, under the header. Errors stay longer and are announced assertively. */

export function Toasts() {
  const toasts = useApp((state) => state.toasts)
  // The tray opens in the same corner and already lists what these toasts announce.
  const trayOpen = useTray((state) => state.open)
  return (
    <div className="toasts" aria-live="polite">
      {!trayOpen && toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

function ToastItem({ toast }: { readonly toast: Toast }) {
  const Icon = toast.level === "error" ? CircleAlert : toast.level === "success" ? CircleCheck : Info
  return (
    <div className={cx("toast", `is-${toast.level}`)} role={toast.level === "error" ? "alert" : "status"}>
      <Icon size={14} className="toast-icon" />
      <span className="toast-text">{toast.text}</span>
      {toast.action !== undefined && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action?.run()
            dismissToast(toast.id)
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
        <X size={12} />
      </button>
    </div>
  )
}
