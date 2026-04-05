import type { ScrollbackWriter } from "@opentui/core"
import { toolView } from "./tool"
import { snapEntryWriter, textEntryWriter } from "./scrollback.writer"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

export function entryWriter(
  commit: StreamCommit,
  theme: RunEntryTheme = RUN_THEME_FALLBACK.entry,
  opts: ScrollbackOptions = {},
): ScrollbackWriter {
  const state = commit.toolState ?? commit.part?.state.status
  if (commit.kind === "tool" && commit.phase === "final" && state === "completed") {
    if (toolView(commit.tool).snap) {
      return snapEntryWriter(commit, theme, opts)
    }
  }

  return textEntryWriter(commit, theme)
}
