import zlib from "node:zlib"
import { describe, expect } from "bun:test"
import { Cause, Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Session } from "@opencode-ai/schema/session"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventTable } from "@opencode-ai/core/event/sql"
import { EventDataCodecError, CODEC_PREFIX, encodeEventData, decodeEventData } from "@opencode-ai/core/event/codec"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { eq, sql } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_codec") }),
  ),
)

const DurableMessage = SessionV1.Event.MessageRemoved
const durableData = (sessionID: Session.ID, marker: string, filler: string) => ({
  sessionID,
  messageID: SessionV1.MessageID.ascending(`msg_${marker}_${filler}`),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, Location.node]), [[Location.node, locationLayer]]),
)

const rawRows = (db: import("@opencode-ai/core/database/database").Database.Interface["db"], aggregateID: string) =>
  db
    .select({ raw: sql<string>`data` })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, aggregateID))
    .all()
    .pipe(Effect.orDie)

const decodedRows = (db: import("@opencode-ai/core/database/database").Database.Interface["db"], aggregateID: string) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, aggregateID))
    .all()
    .pipe(Effect.orDie)

const largeFiller = "x".repeat(64 * 1024)

describe("event-data-compression codec", () => {
  it.effect("stores small durable events as plain JSON", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.publish(DurableMessage, durableData(aggregateID, "small", ""))
      const raw = yield* rawRows(db, aggregateID)

      expect(raw).toHaveLength(1)
      expect(raw[0]?.raw.startsWith(CODEC_PREFIX)).toBe(false)
      expect(JSON.parse(raw[0]!.raw)).toEqual(durableData(aggregateID, "small", ""))
    }),
  )

  it.effect("stores large durable events gz1-compressed and decodes transparently", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.publish(DurableMessage, durableData(aggregateID, "large", largeFiller))
      const raw = yield* rawRows(db, aggregateID)
      const decoded = yield* decodedRows(db, aggregateID)

      expect(raw[0]?.raw.startsWith(CODEC_PREFIX)).toBe(true)
      expect(raw[0]!.raw.length).toBeLessThan(64 * 1024) // actually compressed
      expect(decoded[0]?.data).toEqual(durableData(aggregateID, "large", largeFiller))
    }),
  )

  it.effect("reads plain and compressed rows of one aggregate in seq order", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = Session.ID.create()

      yield* events.publish(DurableMessage, durableData(aggregateID, "first-small", ""))
      yield* events.publish(DurableMessage, durableData(aggregateID, "second-large", largeFiller))
      yield* events.publish(DurableMessage, durableData(aggregateID, "third-small", ""))
      const raw = yield* rawRows(db, aggregateID)
      const decoded = yield* decodedRows(db, aggregateID)

      expect(raw.map((row) => row.raw.startsWith(CODEC_PREFIX))).toEqual([false, true, false])
      expect(decoded.map((row) => row.data)).toEqual([
        durableData(aggregateID, "first-small", ""),
        durableData(aggregateID, "second-large", largeFiller),
        durableData(aggregateID, "third-small", ""),
      ])
    }),
  )

  it.effect("replay of a compressed row does not diverge", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()

      const event = yield* events.publish(DurableMessage, durableData(aggregateID, "replay", largeFiller))
      if (!event.durable) throw new Error("Expected durable event metadata")

      // Replay the identical payload: the stored row is compressed on disk,
      // the divergence check compares DECODED objects and must match.
      yield* events.replayAll(
        [
          {
            id: event.id,
            aggregateID: event.durable.aggregateID,
            seq: event.durable.seq,
            type: EventV2.versionedType(DurableMessage.type, event.durable.version),
            data: durableData(aggregateID, "replay", largeFiller),
          },
        ],
        { ownerID: "owner-test" },
      )
    }),
  )

  it.effect("fails closed with EventDataCodecError on corrupt gz1 payload", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const aggregateID = Session.ID.create()
      yield* events.publish(DurableMessage, durableData(aggregateID, "corrupt", ""))
      yield* db.run(sql`UPDATE event SET data = ${CODEC_PREFIX + "!!!!"} WHERE aggregate_id = ${aggregateID}`)

      const exit = yield* decodedRows(db, aggregateID).pipe(Effect.exit)
      if (exit._tag !== "Failure") throw new Error("Expected decode of corrupt payload to fail")
      // drizzle wraps the codec error; the structural tag must survive the wrap
      expect(Cause.pretty(exit.cause)).toContain("EventDataCodec")
    }),
  )

  it.effect("kill switch: OPENCODE_EVENT_CODEC=off stores new large payloads plain but still decodes compressed ones", () =>
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EVENT_CODEC
      process.env.OPENCODE_EVENT_CODEC = "off"
      try {
        const large = { filler: "y".repeat(64 * 1024) }
        const stored = encodeEventData(large)
        expect(stored.startsWith(CODEC_PREFIX)).toBe(false)

        const compressed = CODEC_PREFIX + zlib.gzipSync(JSON.stringify(large)).toString("base64")
        expect(decodeEventData(compressed)).toEqual(large)
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_EVENT_CODEC
        else process.env.OPENCODE_EVENT_CODEC = previous
      }
    }),
  )
})
