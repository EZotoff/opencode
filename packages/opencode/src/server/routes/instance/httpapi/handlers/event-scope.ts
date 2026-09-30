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
  instanceDirectory: string,
  scopeAll: boolean,
) {
  if (scopeAll) return true
  if (!HIGH_VOLUME_MESSAGE_EVENTS.has(type)) return true
  if (eventDirectory === undefined) return true
  return eventDirectory === instanceDirectory
}
