import { GraduationCap, X } from "lucide-react"
import { memo, useEffect, useRef, useState, type ReactNode } from "react"
import { lessonDismissed, lessonOpened, lessonSeen, lessonShown } from "../../app/learning"
import { LESSON_VIEW_MS, lessonKey, lessonView, type Lesson, type LessonLevel } from "../../app/lessons"
import { useApp } from "../../app/store"
import { cx, IconButton } from "../common"

/** The lesson table is plain text; backticks mark commands and file names. */
export function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))
}

/** Learn mode's card beside the call it explains. */
export const LessonCard = memo(function LessonCard({ threadId, anchor, lesson, level }: { readonly threadId: string; readonly anchor: string; readonly lesson: Lesson; readonly level: LessonLevel }) {
  const ref = useRef<HTMLElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  // Time on screen: what passed before, and since when it is in view now.
  const viewed = useRef<{ total: number; since?: number }>({ total: 0 })

  useEffect(() => lessonShown(threadId, anchor, level, lesson.id), [threadId, anchor, level, lesson.id])

  useEffect(() => {
    const element = ref.current
    if (element === null || typeof IntersectionObserver === "undefined") return
    let visible = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const pause = (): void => {
      const { since } = viewed.current
      if (since !== undefined) viewed.current = { total: viewed.current.total + performance.now() - since }
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const resume = (): void => {
      if (viewed.current.since !== undefined || document.visibilityState !== "visible") return
      viewed.current = { ...viewed.current, since: performance.now() }
      if (!useApp.getState().learning.seen.includes(lessonKey(level, lesson.id))) timer = setTimeout(() => lessonSeen(threadId, anchor, level, lesson.id), Math.max(0, LESSON_VIEW_MS - viewed.current.total))
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting === true
        if (visible) resume()
        else pause()
      },
      { threshold: 0.6 },
    )
    const onVisibility = (): void => {
      if (visible && document.visibilityState === "visible") resume()
      else pause()
    }
    observer.observe(element)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      pause()
      observer.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [threadId, anchor, level, lesson.id])

  const view = lessonView(lesson, level, expanded)
  const toggle = (): void => {
    if (!expanded) lessonOpened(threadId, anchor, level, lesson.id)
    setExpanded(!expanded)
  }
  const dismiss = (): void => {
    const { total, since } = viewed.current
    lessonDismissed(threadId, level, lesson.id, total + (since === undefined ? 0 : performance.now() - since))
  }

  return (
    <section ref={ref} className={cx("row-lesson", `is-${level}`)} aria-label={`Lesson: ${lesson.title}`}>
      <span className="lesson-icon" aria-hidden>
        <GraduationCap size={14} />
      </span>
      <div className="lesson-text">
        <div className="lesson-title">{view.title}</div>
        {view.body !== undefined && <p className="lesson-body">{withCode(view.body)}</p>}
        {view.fact !== undefined && (
          <p className="lesson-extra">
            <span className="lesson-label">Did you know?</span> {withCode(view.fact)}
          </p>
        )}
        {view.watch !== undefined && (
          <p className="lesson-extra">
            <span className="lesson-label">Watch for</span> {withCode(view.watch)}
          </p>
        )}
      </div>
      <div className="lesson-actions">
        {(view.more || expanded) && (
          <button type="button" className="lesson-more" aria-expanded={expanded} onClick={toggle}>
            {expanded ? "Less" : "More"}
          </button>
        )}
        <IconButton label="Dismiss lesson" size="sm" onClick={dismiss}>
          <X size={13} />
        </IconButton>
      </div>
    </section>
  )
})
