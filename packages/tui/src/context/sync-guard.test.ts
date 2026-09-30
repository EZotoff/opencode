import { describe, expect, test } from "bun:test"
import { shouldApplySessionEvent } from "./sync-guard"

const kvOn = { get: (key: string, fallback: boolean) => fallback }
const kvOff = { get: (key: string, fallback: boolean) => false }

function store(known: string[]) {
  return { session: known.map((id) => ({ id })) as never }
}

describe("shouldApplySessionEvent", () => {
  test("drops foreign-directory message.updated for unknown session", () => {
    expect(shouldApplySessionEvent(store([]), "ses_foreign", "/other/dir", "/own/dir", kvOn)).toBe(false)
  })

  test("keeps own-directory events for unknown session", () => {
    expect(shouldApplySessionEvent(store([]), "ses_new", "/own/dir", "/own/dir", kvOn)).toBe(true)
  })

  test("keeps events when event carries no directory", () => {
    expect(shouldApplySessionEvent(store([]), "ses_any", undefined, "/own/dir", kvOn)).toBe(true)
  })

  test("keeps events when sdk directory unknown", () => {
    expect(shouldApplySessionEvent(store([]), "ses_any", "/other/dir", undefined, kvOn)).toBe(true)
  })

  test("keeps already-known session even from foreign directory", () => {
    expect(shouldApplySessionEvent(store(["ses_known"]), "ses_known", "/other/dir", "/own/dir", kvOn)).toBe(true)
  })

  test("kv flag off bypasses the guard entirely", () => {
    expect(shouldApplySessionEvent(store([]), "ses_foreign", "/other/dir", "/own/dir", kvOff)).toBe(true)
  })
})
