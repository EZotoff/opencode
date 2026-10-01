import { describe, expect, test } from "bun:test"
import { passesEventScope } from "@/server/routes/instance/httpapi/handlers/event-scope"

describe("event SSE scope filter", () => {
  test("drops foreign-directory message.part.updated for scoped subscriber", () => {
    expect(passesEventScope("message.part.updated", "/other/dir", "/own/dir", false)).toBe(false)
  })

  test("keeps own-directory message.part.updated", () => {
    expect(passesEventScope("message.part.updated", "/own/dir", "/own/dir", false)).toBe(true)
  })

  test("opt-in scope=all keeps foreign-directory message.part.updated", () => {
    expect(passesEventScope("message.part.updated", "/other/dir", "/own/dir", true)).toBe(true)
  })

  test("keeps events carrying no directory", () => {
    expect(passesEventScope("message.part.updated", undefined, "/own/dir", false)).toBe(true)
  })

  test("keeps non-message-class events from foreign directories", () => {
    expect(passesEventScope("session.updated", "/other/dir", "/own/dir", false)).toBe(true)
    expect(passesEventScope("server.heartbeat", "/other/dir", "/own/dir", false)).toBe(true)
  })

  test("filter list covers the high-volume message classes", () => {
    for (const type of [
      "message.updated",
      "message.removed",
      "message.part.updated",
      "message.part.removed",
      "message.part.delta",
      "todo.updated",
      "session.diff",
    ]) {
      expect(passesEventScope(type, "/other/dir", "/own/dir", false)).toBe(false)
    }
  })
})

describe("event SSE scope filter v2 (session-level + global route)", () => {
  const own = new Set(["ses_own"])

  test("session declared: drops same-directory other-session part events", () => {
    expect(passesEventScope("message.part.updated", "/d", "/d", false, "ses_other", own)).toBe(false)
  })

  test("session declared: keeps declared-session part events", () => {
    expect(passesEventScope("message.part.updated", "/d", "/d", false, "ses_own", own)).toBe(true)
  })

  test("session declared: event without sessionID falls back to directory pass", () => {
    expect(passesEventScope("message.part.updated", "/d", "/d", false, undefined, own)).toBe(true)
  })

  test("no session declared (v2.0 TUI): directory check only", () => {
    expect(passesEventScope("message.part.updated", "/d", "/d", false, "ses_other", undefined)).toBe(true)
  })

  test("global route: no directory declared (param-less) passes everything", () => {
    expect(passesEventScope("message.part.updated", "/anywhere", undefined, false, "ses_x", undefined)).toBe(true)
  })

  test("scope=all overrides session scoping", () => {
    expect(passesEventScope("message.part.updated", "/d", "/d", true, "ses_other", own)).toBe(true)
  })

  test("eventSessionID extracts across payload shapes", () => {
    const { eventSessionID } = require("@/server/routes/instance/httpapi/handlers/event-scope")
    expect(eventSessionID({ sessionID: "s1" })).toBe("s1")
    expect(eventSessionID({ part: { sessionID: "s2" } })).toBe("s2")
    expect(eventSessionID({ info: { sessionID: "s3" } })).toBe("s3")
    expect(eventSessionID({ message: { sessionID: "s4" } })).toBe("s4")
    expect(eventSessionID({})).toBe(undefined)
    expect(eventSessionID(undefined)).toBe(undefined)
  })

  test("comma-joined session param semantics (server parses a,b)", () => {
    const parsed = new Set("a,b".split(","))
    expect(passesEventScope("message.part.updated", "/d", "/d", false, "a", parsed)).toBe(true)
    expect(passesEventScope("message.part.updated", "/d", "/d", false, "c", parsed)).toBe(false)
  })
})

describe("sync-mirrored event scoping", () => {
  test("effectiveEventType sees through sync wrapper and strips .1 suffix", () => {
    const { effectiveEventType } = require("@/server/routes/instance/httpapi/handlers/event-scope")
    expect(effectiveEventType({ type: "sync", syncEvent: { type: "message.part.updated.1" } })).toBe("message.part.updated")
    expect(effectiveEventType({ type: "session.updated" })).toBe("session.updated")
  })

  test("scopedSessionID uses sync aggregateID; properties otherwise", () => {
    const { scopedSessionID } = require("@/server/routes/instance/httpapi/handlers/event-scope")
    expect(scopedSessionID({ type: "sync", syncEvent: { type: "message.part.updated.1", aggregateID: "ses_x" } })).toBe("ses_x")
    expect(scopedSessionID({ type: "message.part.updated", properties: { part: { sessionID: "ses_y" } } })).toBe("ses_y")
  })

  test("sync-mirrored foreign part event is dropped for scoped subscriber", () => {
    const { effectiveEventType } = require("@/server/routes/instance/httpapi/handlers/event-scope")
    expect(passesEventScope(effectiveEventType({ type: "sync", syncEvent: { type: "message.part.updated.1" } }), "/other", "/own", false)).toBe(false)
  })
})
