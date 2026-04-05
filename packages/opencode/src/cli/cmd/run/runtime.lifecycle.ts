import { createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import { Locale } from "../../../util/locale"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { resolveRunTheme } from "./theme"
import type {
  FooterApi,
  FooterKeybinds,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunDiffStyle,
  RunInput,
} from "./types"
import { formatModelLabel } from "./variant.shared"

const FOOTER_HEIGHT = 7
const DEFAULT_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type SplashState = {
  entry: boolean
  exit: boolean
}

type CycleResult = {
  modelLabel?: string
  status?: string
}

type FooterLabels = {
  agentLabel: string
  modelLabel: string
}

export type LifecycleInput = {
  sessionID: string
  sessionTitle?: string
  first: boolean
  history: string[]
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  keybinds: FooterKeybinds
  diffStyle: RunDiffStyle
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onInterrupt?: () => void
}

export type Lifecycle = {
  footer: FooterApi
  close(input: { showExit: boolean }): Promise<void>
}

function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashTitle(title: string | undefined, history: string[]): string | undefined {
  if (title && !DEFAULT_TITLE.test(title)) {
    return title
  }

  const next = history.find((item) => item.trim().length > 0)
  return next ?? title
}

function footerLabels(input: Pick<RunInput, "agent" | "model" | "variant">): FooterLabels {
  const agentLabel = Locale.titlecase(input.agent ?? "build")

  if (!input.model) {
    return {
      agentLabel,
      modelLabel: "Model default",
    }
  }

  return {
    agentLabel,
    modelLabel: formatModelLabel(input.model, input.variant),
  }
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

export async function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  const renderer = await createCliRenderer({
    targetFps: 30,
    maxFps: 60,
    useMouse: false,
    autoFocus: false,
    openConsoleOnError: false,
    exitOnCtrlC: false,
    useKittyKeyboard: { events: process.platform === "win32" },
    screenMode: "split-footer",
    footerHeight: FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })
  let theme = await resolveRunTheme(renderer)
  renderer.setBackgroundColor(theme.background)
  const state: SplashState = {
    entry: false,
    exit: false,
  }
  const meta = splashMeta({
    title: splashTitle(input.sessionTitle, input.history),
    session_id: input.sessionID,
  })
  queueSplash(
    renderer,
    state,
    "entry",
    entrySplash({
      ...meta,
      theme: theme.entry,
      background: theme.background,
    }),
  )
  await renderer.idle().catch(() => {})

  const { RunFooter } = await import("./footer")

  const labels = footerLabels({
    agent: input.agent,
    model: input.model,
    variant: input.variant,
  })
  const footer = new RunFooter(renderer, {
    ...labels,
    first: input.first,
    history: input.history,
    theme,
    keybinds: input.keybinds,
    diffStyle: input.diffStyle,
    onPermissionReply: input.onPermissionReply,
    onQuestionReply: input.onQuestionReply,
    onQuestionReject: input.onQuestionReject,
    onCycleVariant: input.onCycleVariant,
    onInterrupt: input.onInterrupt,
  })

  const sigint = () => {
    footer.requestExit()
  }
  process.on("SIGINT", sigint)

  let closed = false
  const close = async (next: { showExit: boolean }) => {
    if (closed) {
      return
    }

    closed = true
    process.off("SIGINT", sigint)

    try {
      const show = renderer.isDestroyed ? false : next.showExit
      if (!renderer.isDestroyed && show) {
        queueSplash(
          renderer,
          state,
          "exit",
          exitSplash({
            ...meta,
            theme: theme.entry,
            background: theme.background,
          }),
        )
        await renderer.idle().catch(() => {})
      }
    } finally {
      footer.close()
      footer.destroy()
      shutdown(renderer)
    }
  }

  return {
    footer,
    close,
  }
}
