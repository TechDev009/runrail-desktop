import { ArrowLeft, CircleCheck, CircleDashed, CircleX, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { cx, Spinner } from "../common"
import type { StatusTone } from "./text"

/** Small pieces shared by the connection list, the connect dialog, and the sign-in sheet. */

function ToneIcon({ tone, size }: { readonly tone: StatusTone; readonly size: number }) {
  switch (tone) {
    case "ok":
      return <CircleCheck size={size} aria-hidden />
    case "busy":
      return <Spinner size={size} />
    case "warn":
      return <TriangleAlert size={size} aria-hidden />
    case "fail":
      return <CircleX size={size} aria-hidden />
    default:
      return <CircleDashed size={size} aria-hidden />
  }
}

/** Status as icon + color + text; color is never the only signal. */
export function StatusChip({ tone, label }: { readonly tone: StatusTone; readonly label: string }) {
  return (
    <span className={cx("conn-chip", `is-${tone}`)}>
      <ToneIcon tone={tone} size={12} />
      {label}
    </span>
  )
}

/** One line that reports how something went. */
export function Notice({ tone, children, role = "status" }: { readonly tone: StatusTone; readonly children: ReactNode; readonly role?: "status" | "alert" }) {
  return (
    <div className={cx("conn-notice", `is-${tone}`)} role={role}>
      <ToneIcon tone={tone} size={13} />
      <span>{children}</span>
    </div>
  )
}

/** Text with `code` spans for the parts written between backticks. */
export function Inline({ text }: { readonly text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="conn-code">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}

export function BackButton({ onBack, disabled }: { readonly onBack: () => void; readonly disabled?: boolean }) {
  return (
    <button type="button" className="conn-back" onClick={onBack} disabled={disabled}>
      <ArrowLeft size={13} aria-hidden />
      All providers
    </button>
  )
}
