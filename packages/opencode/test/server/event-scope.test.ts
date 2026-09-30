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
