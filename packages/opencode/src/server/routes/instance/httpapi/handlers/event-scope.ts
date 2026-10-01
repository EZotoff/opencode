// opencode--event-scope-attach-congestion (S1): scope the /event SSE stream so an
// `opencode attach` viewer only receives high-volume message-class events produced
// by its own directory. On a shared server, every subscriber previously received
// every busy session's full message payloads (loopback + RSS regression measured at
// ~8 MiB/s per idle window). Cross-directory observers keep working: non-message
// events are never filtered, and clients may opt back into the full firehose with
// `?scope=all`. Events without a directory pass (same semantics as the client-side
// guard in packages/tui/src/context/sync-guard.ts).
export const HIGH_VOLUME_MESSAGE_EVENTS = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "todo.updated",
  "session.diff",
])

export function passesEventScope(
  type: string,
  eventDirectory: string | undefined,
  instanceDirectory: string | undefined,
  scopeAll: boolean,
  eventSessionID: string | undefined = undefined,
  sessions: ReadonlySet<string> | undefined = undefined,
) {
  if (scopeAll) return true
  if (!HIGH_VOLUME_MESSAGE_EVENTS.has(type)) return true
  if (eventDirectory === undefined) return true
  if (instanceDirectory !== undefined && eventDirectory !== instanceDirectory) return false
  // v2: session-level scoping — when a subscriber declares its rendered
  // sessions, high-volume events for other sessions in the same directory
  // are dropped per-connection (the bench-fleet same-directory fanout case).
  if (sessions !== undefined && sessions.size > 0 && eventSessionID !== undefined) {
    return sessions.has(eventSessionID)
  }
  return true
}

/**
 * Effective event type for scoping: durable `sync` events MIRROR the original
 * event nested in syncEvent (type "message.part.updated.1" etc.) — the nested
 * payload is just as fat, so scoping must see through the wrapper.
 */
export function effectiveEventType(payload: {
  type: string
  properties?: unknown
  syncEvent?: { type?: string; aggregateID?: string }
}): string {
  if (payload.type === "sync" && typeof payload.syncEvent?.type === "string") {
    return payload.syncEvent.type.replace(/\.1$/, "")
  }
  return payload.type
}

/** SessionID for scoping: sync events carry aggregateID (= sessionID); direct
 * events carry it in properties (part/info/message/sessionID). */
export function scopedSessionID(payload: {
  type: string
  properties?: unknown
  syncEvent?: { type?: string; aggregateID?: string }
}): string | undefined {
  if (payload.type === "sync" && typeof payload.syncEvent?.aggregateID === "string") {
    return payload.syncEvent.aggregateID
  }
  return eventSessionID(payload.properties)
}

/** Extract a sessionID from an event's properties across the payload shapes
 * used by high-volume classes (part.sessionID / info.sessionID / sessionID). */
export function eventSessionID(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null) return undefined
  const p = properties as Record<string, unknown>
  for (const key of ["sessionID", "part", "info", "message"]) {
    const v = p[key]
    if (typeof v === "string") return v
    if (typeof v === "object" && v !== null) {
      const sid = (v as Record<string, unknown>).sessionID
      if (typeof sid === "string") return sid
    }
  }
  return undefined
}
