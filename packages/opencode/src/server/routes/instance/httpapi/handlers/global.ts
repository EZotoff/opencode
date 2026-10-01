import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { effectiveEventType, passesEventScope, scopedSessionID } from "./event-scope"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

// opencode--event-scope-attach-congestion v2: per-connection scoping on the
// GLOBAL route (the one `opencode attach` actually subscribes to). High-volume
// message-class events are dropped per-connection unless they match the
// subscriber's declared directory (?directory=) and, when declared, its
// rendered sessions (?session=a&session=b or ?session=a,b). `?scope=all`
// restores the firehose (dash/beacon). Param-less subscribers: unfiltered
// (v1 behavior) — no unknown-client regression.
function eventResponse(requestUrl: string | undefined) {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const url = requestUrl === undefined ? undefined : new URL(requestUrl, "http://localhost")
    const scopeAll = url?.searchParams.get("scope") === "all"
    const scopeDirectory = url?.searchParams.get("directory") ?? undefined
    const scopeSessions = new Set<string>()
    for (const raw of url?.searchParams.getAll("session") ?? []) {
      for (const part of raw.split(",")) if (part !== "") scopeSessions.add(part)
    }
    const sessions = scopeSessions.size > 0 ? scopeSessions : undefined
    // opencode--sse-queue-bounded: sliding (drop-oldest) cap — same rationale
    // as event.ts (upstream #45215); healthy consumers drain in ms, slow ones
    // drop stale events (part.updated snapshots reconcile on next delivery).
    const events = Stream.callback<GlobalBusEvent>(
      (queue) => {
      const handler = (event: GlobalBusEvent) => {
        if (
          !passesEventScope(
            effectiveEventType(event.payload),
            event.directory,
            scopeDirectory,
            scopeAll,
            scopedSessionID(event.payload),
            sessions,
          )
        ) {
          return
        }
        Queue.offerUnsafe(queue, event)
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
      },
      { bufferSize: 256, strategy: "sliding" },
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* (ctx: { request: { url: string } }) {
      return yield* eventResponse(ctx.request.url)
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
