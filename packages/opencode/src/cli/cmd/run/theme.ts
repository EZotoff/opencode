import { RGBA, type CliRenderer, type ColorInput } from "@opentui/core"
import type { EntryKind } from "./types"

type Tone = {
  body: ColorInput
}

export type RunEntryTheme = Record<EntryKind, Tone>

export type RunFooterTheme = {
  highlight: ColorInput
  muted: ColorInput
  text: ColorInput
  surface: ColorInput
  line: ColorInput
}

export type RunTheme = {
  background: ColorInput
  footer: RunFooterTheme
  entry: RunEntryTheme
}

type Resolved = {
  background: RGBA
  backgroundElement: RGBA
  primary: RGBA
  warning: RGBA
  error: RGBA
  text: RGBA
  textMuted: RGBA
}

function alpha(color: RGBA, value: number): RGBA {
  const a = Math.max(0, Math.min(1, value))
  return RGBA.fromValues(color.r, color.g, color.b, a)
}

function rgba(hex: string, value?: number): RGBA {
  const color = RGBA.fromHex(hex)
  if (value === undefined) {
    return color
  }

  return alpha(color, value)
}

function mode(bg: RGBA): "dark" | "light" {
  const lum = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b
  if (lum > 0.5) {
    return "light"
  }

  return "dark"
}

function map(theme: Resolved): RunTheme {
  const pane = theme.backgroundElement
  const surface = alpha(pane, pane.a === 0 ? 0.18 : Math.min(0.9, pane.a * 0.88))
  const line = alpha(pane, pane.a === 0 ? 0.24 : Math.min(0.98, pane.a * 0.96))

  return {
    background: theme.background,
    footer: {
      highlight: theme.primary,
      muted: theme.textMuted,
      text: theme.text,
      surface,
      line,
    },
    entry: {
      system: {
        body: theme.textMuted,
      },
      user: {
        body: theme.primary,
      },
      assistant: {
        body: theme.text,
      },
      reasoning: {
        body: theme.textMuted,
      },
      tool: {
        body: theme.warning,
      },
      error: {
        body: theme.error,
      },
    },
  }
}

const seed = {
  highlight: rgba("#38bdf8"),
  muted: rgba("#64748b"),
  text: rgba("#f8fafc"),
  panel: rgba("#0f172a"),
  warning: rgba("#f59e0b"),
  error: rgba("#ef4444"),
}

function tone(body: ColorInput): Tone {
  return {
    body,
  }
}

export const RUN_THEME_FALLBACK: RunTheme = {
  background: RGBA.fromValues(0, 0, 0, 0),
  footer: {
    highlight: seed.highlight,
    muted: seed.muted,
    text: seed.text,
    surface: alpha(seed.panel, 0.86),
    line: alpha(seed.panel, 0.96),
  },
  entry: {
    system: tone(seed.muted),
    user: tone(seed.highlight),
    assistant: tone(seed.text),
    reasoning: tone(seed.muted),
    tool: tone(seed.warning),
    error: tone(seed.error),
  },
}

export async function resolveRunTheme(renderer: CliRenderer): Promise<RunTheme> {
  try {
    const colors = await renderer.getPalette({
      size: 16,
    })
    const bg = colors.defaultBackground ?? colors.palette[0]
    if (!bg) {
      return RUN_THEME_FALLBACK
    }

    const pick = renderer.themeMode ?? mode(RGBA.fromHex(bg))
    const mod = await import("../tui/context/theme")
    return map(mod.resolveTheme(mod.generateSystem(colors, pick), pick) as Resolved)
  } catch {
    return RUN_THEME_FALLBACK
  }
}
