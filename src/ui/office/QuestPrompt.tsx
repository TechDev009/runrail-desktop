import { closeDialog } from "../../app/actions"
import { answerQuests, useQuestFiles } from "../../app/play"
import { useApp } from "../../app/store"
import { Button, Modal } from "../common"
import { questIcon, questRule } from "./Quests"

/**
 * Asks before a repository's quests count: once per version of the file. Everything shown comes
 * from the file as plain text; accepting changes nothing but what the game layer counts.
 */
export function QuestPrompt({ projectId }: { readonly projectId: string }) {
  const file = useQuestFiles((files) => files[projectId])
  const name = useApp((state) => state.projects.find((project) => project.id === projectId)?.name ?? "This project")
  const answer = (accepted: boolean): void => {
    answerQuests(projectId, accepted)
    closeDialog()
  }
  if (file === undefined || file === null || !file.result.ok) {
    return (
      <Modal title="Quests" onClose={closeDialog} width={440} footer={<Button onClick={closeDialog}>Close</Button>}>
        <p className="quest-dialog-note">{name} no longer has a quest file Runrail can use.</p>
      </Modal>
    )
  }
  const season = file.result.season
  const dates = season.starts !== undefined && season.ends !== undefined ? `${season.starts} to ${season.ends}` : season.ends !== undefined ? `until ${season.ends}` : season.starts !== undefined ? `from ${season.starts}` : undefined
  return (
    <Modal
      title="This repository sets quests"
      onClose={closeDialog}
      width={540}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(false)}>
            Ignore
          </Button>
          <Button variant="primary" data-autofocus="" onClick={() => answer(true)}>
            Accept
          </Button>
        </>
      }
    >
      <div className="quest-dialog">
        <div className="quest-dialog-head">
          <span className="quest-dialog-season">{season.title}</span>
          <span className="quest-dialog-meta">
            {name} · .runrail/quests.md{dates === undefined ? "" : ` · ${dates}`}
          </span>
          {file.localEdits && (
            <span className="quest-dialog-edits">
              <span className="quest-badge">Local edits</span> This copy is not the committed one.
            </span>
          )}
        </div>
        <ul className="quest-list">
          {season.quests.map((quest) => (
            <li key={quest.id} className="quest-list-item">
              <span className="quest-list-icon" aria-hidden>
                {questIcon(quest.counts)}
              </span>
              <span className="quest-list-text">
                <span className="quest-list-title">{quest.title}</span>
                <span className="quest-list-rule">{questRule(quest)}</span>
              </span>
              <span className="quest-list-xp">{quest.xp} XP</span>
            </li>
          ))}
        </ul>
        <p className="quest-dialog-note">Quests count only what you confirm in Runrail, such as answering a request or committing from Review. Denying a request earns the same as approving it. Progress stays on this machine, and the file cannot change any setting.</p>
      </div>
    </Modal>
  )
}
