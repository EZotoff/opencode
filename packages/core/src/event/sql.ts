import { sqliteTable, text, integer, index, uniqueIndex, customType } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "../event"
import { encodeEventData, decodeEventData } from "./codec"

/** opencode--event-data-compression: transparent gz1 codec on the storage seam. */
export const eventDataColumn = customType<{
  data: Record<string, unknown>
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(input) {
    return encodeEventData(input)
  },
  fromDriver(input) {
    return decodeEventData(input)
  },
})

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
})

export const EventTable = sqliteTable(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    data: eventDataColumn().$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
