import { expect, test } from "bun:test"
import { compactPath, pathCrumbs } from "../src/lib/format"

test("a folder reads by home and its last few folders", () => {
  expect(compactPath("/Users/sam/code/app")).toBe("~/code/app")
  expect(compactPath("/Users/sam/a/b/c/app")).toBe("…/b/c/app")
  expect(compactPath("/private/tmp/x/y/z/demo-app")).toBe("…/y/z/demo-app")
  expect(compactPath("/srv/app")).toBe("/srv/app")
})

test("a breadcrumb names every folder, home as ~ and the root as /", () => {
  expect(pathCrumbs("/Users/sam/Desktop/apps/runrail")).toEqual(["~", "Desktop", "apps", "runrail"])
  expect(pathCrumbs("/srv/app/")).toEqual(["/", "srv", "app"])
  expect(pathCrumbs("C:\\code\\app")).toEqual(["C:", "code", "app"])
})
