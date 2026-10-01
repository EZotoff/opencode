import type { Session } from "@opencode-ai/sdk/v2"

type KvLike = { get(key: string, fallback: boolean): boolean }
type SessionStoreLike = { session: Session[] }

// opencode--event-scope-attach-congestion (S2): the daemon's global /event stream is
// unfiltered (server event.ts scopes only by workspaceID), so every `opencode attach`
// TUI on a shared server receives — and used to STORE — every other directory's
// message/part/todo/diff payloads, growing RSS with foreign-session state. Decide
// whether a per-session-writing event may touch this TUI's store: apply when the event
// originates in this TUI's own directory, when it carries no directory, when the sdk
// directory is unknown, when the filter flag is off, or when the session is already
// known (so updates to legitimately observed sessions keep flowing).
export function shouldApplySessionEvent(
  store: SessionStoreLike,
  sessionID: string,
  evDirectory: string | undefined,
  sdkDirectory: string | undefined,
  kv: KvLike,
) {
  if (!kv.get("session_directory_filter_enabled", true)) return true
  if (!sdkDirectory) return true
  if (evDirectory === undefined) return true
  if (evDirectory === sdkDirectory) return true
  return store.session.some((s) => s.id === sessionID)
}
