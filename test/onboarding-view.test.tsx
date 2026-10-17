import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Onboarding } from "../src/ui/onboarding/Onboarding"

describe("onboarding view", () => {
  test("opens on the welcome step, with progress, skip, and no way back", () => {
    const html = renderToStaticMarkup(<Onboarding />)
    expect(html).toContain("Welcome to Runrail")
    expect(html).toContain("Get started")
    expect(html).toContain("Skip setup")
    expect(html).not.toContain(">Back<")
    // Plan limits and setup join the steps once the scans find something.
    expect(html).toContain('aria-label="Step 1 of 3"')
    expect(html.match(/<i class="is-now"><\/i>/g)?.length).toBe(1)
  })
})
