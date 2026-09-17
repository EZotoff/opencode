import { randomUUID } from "node:crypto"
import { ProcessGroup } from "@opencode-ai/core/process-group"
import { Effect } from "effect"
import { registerDisposer } from "@/effect/instance-registry"

export type CompletionReason = "exit" | "timeout" | "abort"
export type Containment = "contained" | "escaped-observed" | "unknown"
export type SignalOutcome = "live-target" | "esrch" | "identity-mismatch" | "unverified" | "disarmed" | "error" | null

export type Event = {
  readonly invocationID: string
  readonly reason: CompletionReason
  readonly containment: Containment
  readonly term: SignalOutcome
  readonly kill: SignalOutcome
  readonly cleanupMs: number
  readonly forcedPipeClose: boolean
  readonly drainTruncated: boolean
}

export type State = {
  reason: CompletionReason
  containment: Containment
  term: SignalOutcome
  kill: SignalOutcome
  cleanupMs: number
  forcedPipeClose: boolean
  drainTruncated: boolean
}

type Entry = {
  readonly instanceID: string
  readonly invocationID: string
  readonly directory: string
  readonly group: ProcessGroup.Group
}

type Hooks = {
  readonly registered?: (key: string) => void
  readonly visible?: (key: string) => void
  readonly event?: (event: Event) => void
}

const serverInstanceID = randomUUID()
// Best-effort orderly-shutdown ownership only: this cannot cover crashes, OOM, or SIGKILL,
// and cleanup must never signal groups registered by another server instance.
const registry = new Map<string, Entry>()
const counters = new Map<string, number>()
const COUNTER_CAP = 64
const AGGREGATE_INTERVAL_MS = 60_000
let lastAggregateAt = 0
let hooks: Hooks = {}

const keyOf = (instanceID: string, invocationID: string) => `${instanceID}:${invocationID}`

export const invocationID = (value: string | undefined) => value ?? randomUUID()

export const register = (input: {
  readonly invocationID: string
  readonly directory: string
  readonly group: ProcessGroup.Group
}) => {
  const key = keyOf(serverInstanceID, input.invocationID)
  registry.set(key, { instanceID: serverInstanceID, ...input })
  hooks.registered?.(key)
  return key
}

export const visible = (key: string) => hooks.visible?.(key)

export const remove = (key: string) => registry.delete(key)

const terminate = async (entry: Entry) => {
  ProcessGroup.signal(entry.group, "SIGTERM")
  await Bun.sleep(100)
  const members = ProcessGroup.members(entry.group)
  if (members === undefined || members.length > 0) ProcessGroup.signal(entry.group, "SIGKILL")
  ProcessGroup.disarm(entry.group)
}

export const cleanup = async (directory: string) => {
  const owned = [...registry.entries()].filter(
    ([, entry]) => entry.instanceID === serverInstanceID && entry.directory === directory,
  )
  await Promise.allSettled(owned.map(([, entry]) => terminate(entry)))
  for (const [key] of owned) registry.delete(key)
}

registerDisposer(cleanup)

export const emit = (event: Event) =>
  Effect.gen(function* () {
    hooks.event?.(event)
    const counter = `${event.reason}:${event.containment}`
    if (counters.has(counter) || counters.size < COUNTER_CAP) counters.set(counter, (counters.get(counter) ?? 0) + 1)
    yield* Effect.logInfo("shell invocation lifecycle", event)
    const now = Date.now()
    if (now - lastAggregateAt < AGGREGATE_INTERVAL_MS) return
    lastAggregateAt = now
    yield* Effect.logInfo("shell invocation lifecycle aggregate", { counters: Object.fromEntries(counters) })
  })

export const testing = {
  serverInstanceID,
  setHooks(next: Hooks) {
    hooks = next
  },
  reset() {
    registry.clear()
    counters.clear()
    lastAggregateAt = 0
    hooks = {}
  },
  insert(entry: Entry) {
    registry.set(keyOf(entry.instanceID, entry.invocationID), entry)
  },
  entries() {
    return [...registry.values()]
  },
}

export * as ShellLifecycle from "./lifecycle"
