import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ModelsStep } from "../src/ui/connections/ModelsStep"

test("a connection on every model whose list cannot be read opens still on every model", () => {
  const html = renderToStaticMarkup(
    <ModelsStep title="t" lead="l" options={[]} loading={false} listProblem="Its model list could not be read." initial={undefined} recommended={[]} validId={() => true} saveLabel="Save models" onSave={async () => undefined} />,
  )
  expect(html).toContain("Every model it lists, including ones it adds later")
  expect(html).toMatch(/<input type="checkbox" checked=""/)
  expect(html).not.toContain("Choose at least one model.")
})
