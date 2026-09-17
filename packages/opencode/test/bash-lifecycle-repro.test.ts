// Baseline lifecycle repro for the bash-tool process-group cleanup wedge.
//
// Contract: .sisyphus/debates/bash-lifecycle-orphan-wedge/judges/contract-addendum-v2.md
//   - normal completion requires an EMPTY owned-group enumeration
//   - output EOF never authorizes returning while owned members remain
//   - an escaped (setsid) child holding an inherited fd must not wedge the call
//
// These are the RED baseline cases for the unpatched v1.18.5 source. Scenario (a)
// is expected to pass today (contained group kill already works); (b) and (c) are
// expected to fail until the supervised-lifecycle patch lands.
import { describe, expect } from "bun:test"
import { spawn } from "node:child_process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProcessGroup } from "@opencode-ai/core/process-group"
import { Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { ShellTool } from "../src/tool/shell"
import { provideInstance, testInstanceStoreLayer } from "./fixture/fixture"
import { Agent } from "../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../src/plugin"
import { testEffect } from "./lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { ShellLifecycle } from "@/tool/shell/lifecycle"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("BashLifecycleRepro.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("BashLifecycleRepro.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const projectRoot = path.join(__dirname, "..")
const posix = process.platform !== "win32"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killPid = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone
  }
}

const readPid = async (file: string) => {
  const text = await fs.readFile(file, "utf8")
  const pid = Number(text.trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid file: ${JSON.stringify(text)}`)
  return pid
}

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), "bash-lifecycle-repro-"))

const gone = async (pid: number) => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!alive(pid)) return
    await Bun.sleep(25)
  }
  throw new Error(`pid ${pid} still alive`)
}

const fdCount = async () => (await fs.readdir(`/proc/${process.pid}/fd`)).length

describe("bash lifecycle repro (baseline)", () => {
  it.live(
    "(a) timeout kills contained background members",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const start = Date.now()
          const result = yield* run({
            command: `sleep 30 & echo $! > ${pidFile}; wait`,
            timeout: 500,
          })
          const elapsed = Date.now() - start
          const pid = yield* Effect.promise(() => readPid(pidFile))
          expect(pid).toBeGreaterThan(0)
          expect(alive(pid)).toBe(false)
          expect(elapsed).toBeLessThan(5000)
          expect(result.output).toContain("exceeding timeout")
        }),
      ),
    20_000,
  )

  it.live(
    "registers before visibility and emits redacted lifecycle telemetry",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          ShellLifecycle.testing.reset()
          const order: string[] = []
          const events: ShellLifecycle.Event[] = []
          ShellLifecycle.testing.setHooks({
            registered: () => order.push("registered"),
            visible: () => order.push("visible"),
            event: (event) => events.push(event),
          })
          const canary = "TASK5_SECRET_CANARY"
          yield* run({ command: `printf ${canary}`, timeout: 2000 }, { ...ctx, callID: "inv_redaction" })
          expect(order.slice(0, 2)).toEqual(["registered", "visible"])
          expect(events).toHaveLength(1)
          expect(JSON.stringify(events)).not.toContain(canary)
          expect(events[0]).toMatchObject({
            invocationID: "inv_redaction",
            reason: "exit",
            containment: "contained",
            term: null,
            kill: null,
            forcedPipeClose: false,
            drainTruncated: false,
          })
          expect(events[0]?.cleanupMs).toBeNumber()
          ShellLifecycle.testing.reset()
        }),
      ),
    20_000,
  )

  it.live(
    "orderly shutdown cleans this server instance only",
    () =>
      Effect.gen(function* () {
        if (!posix) return
        ShellLifecycle.testing.reset()
        const own = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
        const foreign = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
        const directory = yield* Effect.promise(scratch)
        try {
          const ownGroup = ProcessGroup.arm(own.pid ?? 0)
          const foreignGroup = ProcessGroup.arm(foreign.pid ?? 0)
          ShellLifecycle.register({ invocationID: "own", directory, group: ownGroup })
          ShellLifecycle.testing.insert({
            instanceID: "foreign-server-instance",
            invocationID: "foreign",
            directory,
            group: foreignGroup,
          })
          yield* Effect.promise(() => ShellLifecycle.cleanup(directory))
          yield* Effect.promise(() => gone(own.pid ?? 0))
          expect(alive(foreign.pid ?? 0)).toBe(true)
          expect(ShellLifecycle.testing.entries().map((entry) => entry.invocationID)).toEqual(["foreign"])
        } finally {
          killPid(own.pid ?? 0)
          killPid(foreign.pid ?? 0)
          ShellLifecycle.testing.reset()
        }
      }),
    20_000,
  )

  it.live(
    "fork burst remains bounded across sequential invocations",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          if (!posix) return
          ShellLifecycle.testing.reset()
          const events: ShellLifecycle.Event[] = []
          ShellLifecycle.testing.setHooks({ event: (event) => events.push(event) })
          const baseline = yield* Effect.promise(fdCount)
          const latencies: number[] = []
          const followups: number[] = []
          for (let invocation = 0; invocation < 5; invocation++) {
            const start = Date.now()
            yield* run(
              { command: `for i in {1..20}; do true & done; sleep 1 & wait`, timeout: 3000 },
              { ...ctx, callID: `inv_burst_${invocation}` },
            )
            latencies.push(Date.now() - start)
            const followupStart = Date.now()
            const followup = yield* run(
              { command: "printf ok", timeout: 2000 },
              { ...ctx, callID: `inv_followup_${invocation}` },
            )
            followups.push(Date.now() - followupStart)
            expect(followup.output).toBe("ok")
          }
          const final = yield* Effect.promise(fdCount)
          console.log("fork-burst-evidence", JSON.stringify({ baseline, final, delta: final - baseline, latencies, followups }))
          expect(latencies.every((latency) => latency < 3000)).toBe(true)
          expect(followups.every((latency) => latency < 500)).toBe(true)
          expect(final - baseline).toBeLessThanOrEqual(5)
          for (let invocation = 0; invocation < 5; invocation++) {
            expect(events.filter((event) => event.invocationID === `inv_burst_${invocation}`).length).toBeLessThanOrEqual(10)
          }
          ShellLifecycle.testing.reset()
        }),
      ),
    30_000,
  )

  it.live(
    "(b) escaped pipe-holder does not wedge completion",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const start = Date.now()
          const exit = yield* run({
            command: `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 20' & echo leader-done`,
            timeout: 3000,
          }).pipe(Effect.exit)
          const elapsed = Date.now() - start
          const pid = yield* Effect.promise(() => readPid(pidFile))
          killPid(pid)
          // RED today: the leader exits immediately but the escaped child holds the
          // inherited stdout pipe, so `close` never fires and the call runs to the
          // full timeout (or dies on the empty-group kill). Bounded drain should
          // return well under the timeout.
          expect(elapsed).toBeLessThan(2000)
          expect(exit._tag).toBe("Success")
        }),
      ),
    30_000,
  )

  it.live(
    "(c) nohup background is killed with the group",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const result = yield* run({
            command: `nohup sleep 30 > /dev/null 2>&1 & echo $! > ${pidFile}; echo done`,
            timeout: 5000,
          })
          const pid = yield* Effect.promise(() => readPid(pidFile))
          const isAlive = alive(pid)
          killPid(pid)
          expect(result.output).toContain("done")
          // RED today: normal completion does not kill the owned group, so the
          // nohup'd member survives the call.
          expect(isAlive).toBe(false)
        }),
      ),
    20_000,
  )

  it.live(
    "(d) SIGTERM-ignoring descendant is KILLed after grace",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const start = Date.now()
          const result = yield* run({
            // trap '' TERM survives the exec: the sleep ignores SIGTERM
            command: `bash -c 'trap "" TERM; echo $BASHPID > ${pidFile}; exec sleep 30' & wait`,
            timeout: 1000,
          })
          const elapsed = Date.now() - start
          const pid = yield* Effect.promise(() => readPid(pidFile))
          expect(pid).toBeGreaterThan(0)
          expect(alive(pid)).toBe(false)
          // TERM (3s grace) then KILL, bounded
          expect(elapsed).toBeLessThan(8000)
          expect(result.output).toContain("exceeding timeout")
          expect(result.metadata.lifecycle.reason).toBe("timeout")
          expect(result.metadata.lifecycle.term).toBe("live-target")
          expect(result.metadata.lifecycle.kill).toBe("live-target")
        }),
      ),
    20_000,
  )

  it.live(
    "(e) setsid escape: group cleaned, escape observable",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const start = Date.now()
          const result = yield* run({
            command: `setsid sh -c 'echo $$ > ${pidFile}; exec sleep 30' & echo started; sleep 30`,
            timeout: 1000,
          })
          const elapsed = Date.now() - start
          const pid = yield* Effect.promise(() => readPid(pidFile))
          // escaped child is outside the owned group: it survives (never swept)
          const escaped = alive(pid)
          killPid(pid)
          expect(escaped).toBe(true)
          expect(elapsed).toBeLessThan(6000)
          expect(result.output).toContain("started")
          expect(result.output).toContain("exceeding timeout")
          // the escaped child holds the inherited pipe -> escape is observed
          expect(result.metadata.lifecycle.containment).toBe("escaped-observed")
          expect(result.metadata.lifecycle.reason).toBe("timeout")
        }),
      ),
    20_000,
  )

  it.live(
    "(f) concurrent timeout+abort race: exactly one cleanup, no post-disarm signal",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const ctl = new AbortController()
          const start = Date.now()
          // fire the abort at the same wall-clock moment as the timeout
          setTimeout(() => ctl.abort(), 1000)
          const exit = yield* run(
            {
              command: `sleep 30 & echo $! > ${pidFile}; wait`,
              timeout: 1000,
            },
            { ...ctx, abort: ctl.signal },
          ).pipe(Effect.exit)
          const elapsed = Date.now() - start
          const pid = yield* Effect.promise(() => readPid(pidFile))
          killPid(pid)
          expect(exit._tag).toBe("Success")
          expect(alive(pid)).toBe(false)
          expect(elapsed).toBeLessThan(6000)
          if (exit._tag === "Success") {
            const reason = exit.value.metadata.lifecycle.reason
            expect(["timeout", "abort"]).toContain(reason)
          }
        }),
      ),
    20_000,
  )

  it.live(
    "(g) leader exits while contained child holds stdout: bounded return",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const dir = yield* Effect.promise(scratch)
          const pidFile = path.join(dir, "pid")
          const start = Date.now()
          const result = yield* run({
            command: `sleep 20 & echo $! > ${pidFile}; echo done`,
            timeout: 1000,
          })
          const elapsed = Date.now() - start
          const pid = yield* Effect.promise(() => readPid(pidFile))
          expect(alive(pid)).toBe(false)
          // non-empty group at the deadline becomes a timeout -> full cleanup
          expect(elapsed).toBeLessThan(6000)
          expect(result.output).toContain("done")
          expect(result.output).toContain("exceeding timeout")
          expect(result.metadata.lifecycle.containment).toBe("contained")
        }),
      ),
    20_000,
  )

  if (!posix) {
    it.live("(b)/(c) skipped on win32", () => Effect.void)
  }
})
