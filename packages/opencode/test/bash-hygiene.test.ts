// Task 6: timeout default/cap (clamp semantics) + detach-pattern warnings +
// shell-hygiene prompt text. Warnings must never block or alter execution.
import { describe, expect, it as plainIt } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import * as ShellHygiene from "../src/tool/shell/hygiene"
import { ShellPrompt } from "../src/tool/shell/prompt"
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
import { Config } from "@/config/config"
import path from "path"

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

const initShell = Effect.fn("BashHygiene.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const run = Effect.fn("BashHygiene.run")(function* (args: Tool.InferParameters<typeof ShellTool>) {
  const bash = yield* initShell()
  return yield* bash.execute(args, ctx)
})

const projectRoot = path.join(__dirname, "..")

describe("resolveTimeout (clamp semantics)", () => {
  plainIt("applies the default when env unset (no requested timeout)", () => {
    const resolved = ShellHygiene.resolveTimeout(undefined, ShellHygiene.DEFAULT_TIMEOUT_MS, ShellHygiene.MAX_TIMEOUT_MS)
    expect(resolved.timeout).toBe(120_000)
    expect(resolved.clampedFrom).toBeUndefined()
  })

  plainIt("keeps in-range requests untouched", () => {
    const resolved = ShellHygiene.resolveTimeout(300_000, 120_000, 1_800_000)
    expect(resolved.timeout).toBe(300_000)
    expect(resolved.clampedFrom).toBeUndefined()
  })

  plainIt("clamps over-cap requests to the cap and reports the original", () => {
    const resolved = ShellHygiene.resolveTimeout(3_600_000, 120_000, 1_800_000)
    expect(resolved.timeout).toBe(1_800_000)
    expect(resolved.clampedFrom).toBe(3_600_000)
  })
})

describe("detachWarnings (warning-only)", () => {
  plainIt("warns on canary detach commands", () => {
    for (const command of ["nohup sleep 100 &", "setsid sh -c 'sleep 5' &", "tail -f /var/log/syslog", "sleep 300", "sleep 90s", "sleep 2m"]) {
      expect(ShellHygiene.detachWarnings(command).length).toBeGreaterThan(0)
    }
  })

  plainIt("does not warn on plain commands", () => {
    for (const command of ["ls", "ls -la /tmp", "sleep 5", "git status", "echo done && printf ok"]) {
      expect(ShellHygiene.detachWarnings(command)).toEqual([])
    }
  })
})

describe("shell hygiene prompt text", () => {
  plainIt("contains the durable-run directive and process-group rules", () => {
    const rendered = ShellPrompt.render("bash", "linux", { maxLines: 1000, maxBytes: 24576 }, 120_000, 1_800_000)
    expect(rendered.description).toContain("opencode durable-run")
    expect(rendered.description).toContain("BY DESIGN")
    expect(rendered.description).toContain("1800000ms are clamped")
  })
})

describe("tool-level behavior", () => {
  it.live(
    "over-cap timeout is clamped with an explicit note; call proceeds",
    () =>
      Effect.gen(function* () {
        const result = yield* run({ command: "echo clamp-probe", timeout: 3_600_000 })
        expect(result.output).toContain("clamp-probe")
        expect(result.output).toContain("clamped requested timeout 3600000 ms to the configured maximum of 1800000 ms")
      }).pipe(provideInstance(projectRoot)),
    30_000,
  )

  it.live(
    "detach canary emits a non-blocking warning and executes normally",
    () =>
      Effect.gen(function* () {
        const result = yield* run({ command: "nohup sleep 100 & echo detach-probe", timeout: 10_000 })
        expect(result.output).toContain("detach-probe")
        expect(result.output).toContain("shell hygiene warning")
        expect(result.output).toContain("opencode durable-run")
      }).pipe(provideInstance(projectRoot)),
    30_000,
  )

  it.live(
    "plain ls gets no hygiene warning",
    () =>
      Effect.gen(function* () {
        const result = yield* run({ command: "ls" })
        expect(result.output).not.toContain("shell hygiene warning")
      }).pipe(provideInstance(projectRoot)),
    30_000,
  )
})