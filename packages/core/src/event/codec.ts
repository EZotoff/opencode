import zlib from "node:zlib"
import fs from "node:fs"
import ospath from "node:path"
import { Schema } from "effect"
import os from "node:os"

/**
 * opencode--event-data-compression: transparent lossless compression of
 * EventTable.data at the storage boundary.
 *
 * Rows whose JSON serialization is >= COMPRESS_THRESHOLD bytes are stored as
 * `gz1:` + base64(gzip(json)); smaller rows stay plain JSON. Every read path
 * goes through {@link decodeEventData} so consumers always receive the
 * original JSON object. Wire payloads, ids, seqs, and the replay deep-equal
 * semantics are unchanged (decode happens below the comparison).
 *
 * Kill switch: OPENCODE_EVENT_CODEC=off disables compression of NEW rows only;
 * decode always stays on (a binary must read what it wrote even after the
 * flag flips).
 */

export const CODEC_PREFIX = "gz1:"
export const COMPRESS_THRESHOLD = 4096

export class EventDataCodecError extends Schema.TaggedErrorClass<EventDataCodecError>()(
  "EventV2.EventDataCodec",
  {
    message: Schema.String,
  },
) {}

const STATS_PATH = ospath.join(os.homedir(), ".local/share/opencode/event-codec-stats.jsonl")
const FLUSH_INTERVAL_MS = 10 * 60 * 1000

type TypeStats = { rawBytes: number; rows: number }

const counters = {
  rawBytes: 0,
  storedBytes: 0,
  rowsCompressed: 0,
  rowsPlain: 0,
  decodeErrors: 0,
}
const byType = new Map<string, TypeStats>()
const segment = { pid: process.pid, startedAt: new Date().toISOString() }

function snapshotLine(): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    pid: segment.pid,
    startedAt: segment.startedAt,
    cumulative: { ...counters },
    byType: Object.fromEntries([...byType].map(([type, s]) => [type, { ...s }])),
  })
}

function flushStats(): void {
  try {
    fs.appendFileSync(STATS_PATH, snapshotLine() + "\n")
  } catch {
    // Stats must never break the codec — a read-only home or a full disk
    // degrades observability, not correctness.
  }
}

let activationFlushed = false

const flushTimer: ReturnType<typeof setInterval> = setInterval(() => flushStats(), FLUSH_INTERVAL_MS)
flushTimer.unref?.()
process.on("exit", () => flushStats())

/** Record raw byte size per durable event type at the publish boundary. */
export function recordEventTypeBytes(type: string, bytes: number): void {
  const stats = byType.get(type) ?? { rawBytes: 0, rows: 0 }
  stats.rawBytes += bytes
  stats.rows += 1
  byType.set(type, stats)
}

/** Serialize + (conditionally) compress an event payload for storage. */
export function encodeEventData(data: Record<string, unknown>): string {
  const raw = JSON.stringify(data)
  if (raw.length < COMPRESS_THRESHOLD || process.env.OPENCODE_EVENT_CODEC === "off") {
    counters.rawBytes += raw.length
    counters.storedBytes += raw.length
    counters.rowsPlain += 1
    return raw
  }
  const stored = CODEC_PREFIX + zlib.gzipSync(raw).toString("base64")
  counters.rawBytes += raw.length
  counters.storedBytes += stored.length
  counters.rowsCompressed += 1
  if (!activationFlushed) {
    // Ladder round 1 evidence: guarantee a stats line exists as soon as the
    // first compression happens (the 10-min cadence alone would be too late).
    activationFlushed = true
    flushStats()
  }
  return stored
}

/** Decode a stored event payload (plain JSON or `gz1:`-compressed). */
export function decodeEventData(raw: string): Record<string, unknown> {
  if (!raw.startsWith(CODEC_PREFIX)) {
    return JSON.parse(raw) as Record<string, unknown>
  }
  try {
    const json = zlib.gunzipSync(Buffer.from(raw.slice(CODEC_PREFIX.length), "base64")).toString()
    return JSON.parse(json) as Record<string, unknown>
  } catch (cause) {
    counters.decodeErrors += 1
    throw new EventDataCodecError({
      message: `Failed to decode compressed event data (${String(cause)}); raw length ${raw.length}`,
    })
  }
}
