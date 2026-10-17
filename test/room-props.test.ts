import { describe, expect, test } from "bun:test"
import { wallProps } from "../src/ui/office/RoomProps"

describe("what hangs on a room's wall", () => {
  test("is picked from the project's id, the same every time, and always has a window or a poster", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `p-${String(index)}`)
    for (const id of ids) {
      const props = wallProps(id)
      expect(props).toEqual(wallProps(id))
      expect(props.window || props.poster).toBe(true)
    }
    const kinds = new Set(ids.map((id) => JSON.stringify(wallProps(id))))
    expect(kinds.size).toBeGreaterThan(3)
  })
})
