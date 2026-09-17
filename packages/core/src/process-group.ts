/**
 * POSIX process-group supervision primitives for the bash tool lifecycle.
 *
 * Contract: .sisyphus/debates/bash-lifecycle-orphan-wedge/judges/contract-addendum-v2.md
 * - identity: the spawned leader must BE the process-group leader (pgrp === pid),
 *   verified via /proc/<pid>/stat field 5 at spawn (arm) and re-checked before
 *   every signal issued while the leader exists
 * - membership: /proc/[0-9]* scan matching field 5 (pgrp) against the recorded
 *   pgid, excluding the leader's pid; empty enumeration == quiescence
 * - signaling gate: kill(-pgid) is issued only while the leader is verified
 *   alive or the immediately preceding enumeration found members
 *   (POSIX.1-2017 XBD §3.106: a process group exists exactly while it has
 *   members, so a non-empty enumeration means the pgid still names THIS group);
 *   after an empty enumeration the pgid is disarmed permanently
 * - unsupported platforms (non-POSIX or no readable /proc) report "unverified"
 *   so callers degrade to single-pid kills and never signal an unverified
 *   numeric pgid
 */
import fs from "node:fs"

export type LeaderState = "alive" | "dead" | "mismatch"

export type SignalResult =
  | { readonly tag: "live-target" }
  | { readonly tag: "esrch" }
  | { readonly tag: "identity-mismatch" }
  | { readonly tag: "disarmed" }
  | { readonly tag: "unverified" }
  | { readonly tag: "error"; readonly error: unknown }

export interface Group {
  readonly pid: number
  readonly armed: boolean
  disarmed: boolean
}

export const supported: boolean = (() => {
  if (process.platform === "win32") return false
  try {
    fs.accessSync("/proc/self/stat", fs.constants.R_OK)
    return true
  } catch {
    return false
  }
})()

/** /proc/<pid>/stat field 5 (pgrp). comm may contain spaces/parens, so parse after the last ")". */
const pgrpOf = (pid: number): number | undefined => {
  let stat: string
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch {
    return undefined
  }
  const end = stat.lastIndexOf(")")
  if (end < 0) return undefined
  const fields = stat.slice(end + 2).split(" ")
  const pgrp = Number(fields[2])
  return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined
}

export const arm = (pid: number): Group => {
  const armed = supported && pgrpOf(pid) === pid
  return { pid, armed, disarmed: !armed }
}

export const leader = (group: Group): LeaderState => {
  if (!group.armed || group.disarmed) return "dead"
  const pgrp = pgrpOf(group.pid)
  if (pgrp === undefined) return "dead"
  // pid reused by a process in a different group: the leader is gone and this
  // numeric pid must never be treated as ours
  return pgrp === group.pid ? "alive" : "mismatch"
}

export const members = (group: Group): number[] | undefined => {
  if (!supported) return undefined
  let entries: string[]
  try {
    entries = fs.readdirSync("/proc")
  } catch {
    return undefined
  }
  const out: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === group.pid) continue
    if (pgrpOf(pid) === group.pid) out.push(pid)
  }
  return out
}

export const signal = (group: Group, sig: NodeJS.Signals): SignalResult => {
  if (!group.armed) return { tag: "unverified" }
  if (group.disarmed) return { tag: "disarmed" }
  const state = leader(group)
  if (state !== "alive") {
    const left = members(group)
    if (left === undefined) return { tag: "unverified" }
    if (left.length === 0) {
      // group is empty: the pgid may be reused from now on, never signal it again
      group.disarmed = true
      return { tag: state === "mismatch" ? "identity-mismatch" : "esrch" }
    }
  }
  try {
    process.kill(-group.pid, sig)
    return { tag: "live-target" }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      group.disarmed = true
      return { tag: "esrch" }
    }
    return { tag: "error", error }
  }
}

export const disarm = (group: Group): void => {
  group.disarmed = true
}

export * as ProcessGroup from "./process-group"
