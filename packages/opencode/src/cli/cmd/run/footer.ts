import { CliRenderEvents, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { TEXTAREA_MAX_ROWS, TEXTAREA_MIN_ROWS } from "./footer.prompt"
import { printableBinding } from "./prompt.shared"
import { RunFooterView } from "./footer.view"
import { normalizeEntry } from "./scrollback.format"
import { entryWriter } from "./scrollback"
import { spacerWriter } from "./scrollback.writer"
import type { RunTheme } from "./theme"
import type {
  FooterApi,
  FooterEvent,
  FooterKeybinds,
  FooterPatch,
  FooterState,
  FooterView,
  PermissionReply,
  QuestionReject,
  QuestionReply,
  RunDiffStyle,
  StreamCommit,
} from "./types"

type CycleResult = {
  modelLabel?: string
  status?: string
}

type RunFooterOptions = {
  agentLabel: string
  modelLabel: string
  first: boolean
  history?: string[]
  theme: RunTheme
  keybinds: FooterKeybinds
  diffStyle: RunDiffStyle
  onPermissionReply: (input: PermissionReply) => void | Promise<void>
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onCycleVariant?: () => CycleResult | void
  onInterrupt?: () => void
  onExit?: () => void
}

const PERMISSION_ROWS = 10
const QUESTION_ROWS = 12

export class RunFooter implements FooterApi {
  private closed = false
  private destroyed = false
  private prompts = new Set<(text: string) => void>()
  private closes = new Set<() => void>()
  private seen = new Set<string>()
  private queue: StreamCommit[] = []
  private pending = false
  private base: number
  private rows = TEXTAREA_MIN_ROWS
  private state: Accessor<FooterState>
  private setState: Setter<FooterState>
  private view: Accessor<FooterView>
  private setView: Setter<FooterView>
  private interruptTimeout: NodeJS.Timeout | undefined
  private exitTimeout: NodeJS.Timeout | undefined
  private interruptHint: string

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      model: options.modelLabel,
      duration: "",
      usage: "",
      first: options.first,
      interrupt: 0,
      exit: 0,
    })
    this.state = state
    this.setState = setState
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })
    this.view = view
    this.setView = setView
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)
    this.interruptHint = printableBinding(options.keybinds.interrupt, options.keybinds.leader) || "esc"

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)

    void render(
      () =>
        createComponent(RunFooterView, {
          state: this.state,
          view: this.view,
          theme: options.theme.footer,
          diffStyle: options.diffStyle,
          keybinds: options.keybinds,
          history: options.history,
          agent: options.agentLabel,
          onSubmit: this.handlePrompt,
          onPermissionReply: this.handlePermissionReply,
          onQuestionReply: this.handleQuestionReply,
          onQuestionReject: this.handleQuestionReject,
          onCycle: this.handleCycle,
          onInterrupt: this.handleInterrupt,
          onExitRequest: this.handleExit,
          onExit: () => this.close(),
          onRows: this.syncRows,
          onStatus: this.setStatus,
        }),
      this.renderer as unknown as Parameters<typeof render>[1],
    ).catch(() => {
      if (!this.destroyed && !this.renderer.isDestroyed) {
        this.close()
      }
    })
  }

  public get isClosed(): boolean {
    return this.closed || this.destroyed || this.renderer.isDestroyed
  }

  public onPrompt(fn: (text: string) => void): () => void {
    this.prompts.add(fn)
    return () => {
      this.prompts.delete(fn)
    }
  }

  public onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn()
      return () => {}
    }

    this.closes.add(fn)
    return () => {
      this.closes.delete(fn)
    }
  }

  public event(next: FooterEvent): void {
    if (next.type === "queue") {
      this.patch({ queue: next.queue })
      return
    }

    if (next.type === "first") {
      this.patch({ first: next.first })
      return
    }

    if (next.type === "model") {
      this.patch({ model: next.model })
      return
    }

    if (next.type === "turn.send") {
      this.patch({
        phase: "running",
        status: "sending prompt",
        queue: next.queue,
      })
      return
    }

    if (next.type === "turn.wait") {
      this.patch({
        phase: "running",
        status: "waiting for assistant",
      })
      return
    }

    if (next.type === "turn.idle") {
      this.patch({
        phase: "idle",
        status: "",
        queue: next.queue,
      })
      return
    }

    if (next.type === "turn.duration") {
      this.patch({ duration: next.duration })
      return
    }

    if (next.type === "stream.patch") {
      if (typeof next.patch.status === "string" && next.patch.phase === undefined) {
        this.patch({ phase: "running", ...next.patch })
        return
      }

      this.patch(next.patch)
      return
    }

    this.present(next.view)
  }

  private patch(next: FooterPatch): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const prev = this.state()
    const state = {
      phase: next.phase ?? prev.phase,
      status: typeof next.status === "string" ? next.status : prev.status,
      queue: typeof next.queue === "number" ? Math.max(0, next.queue) : prev.queue,
      model: typeof next.model === "string" ? next.model : prev.model,
      duration: typeof next.duration === "string" ? next.duration : prev.duration,
      usage: typeof next.usage === "string" ? next.usage : prev.usage,
      first: typeof next.first === "boolean" ? next.first : prev.first,
      interrupt:
        typeof next.interrupt === "number" && Number.isFinite(next.interrupt)
          ? Math.max(0, Math.floor(next.interrupt))
          : prev.interrupt,
      exit:
        typeof next.exit === "number" && Number.isFinite(next.exit) ? Math.max(0, Math.floor(next.exit)) : prev.exit,
    }

    if (state.phase === "idle") {
      state.interrupt = 0
    }

    this.setState(state)

    if (prev.phase === "running" && state.phase === "idle") {
      this.flush()
    }
  }

  private present(view: FooterView): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    this.setView(view)
    this.applyHeight()
  }

  public append(commit: StreamCommit): void {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    if (!normalizeEntry(commit)) {
      return
    }

    const last = this.queue.at(-1)
    if (
      last &&
      last.phase === "progress" &&
      commit.phase === "progress" &&
      last.kind === commit.kind &&
      last.source === commit.source &&
      last.partID === commit.partID &&
      last.tool === commit.tool
    ) {
      last.text += commit.text
    } else {
      this.queue.push(commit)
    }

    if (this.pending) {
      return
    }

    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      this.flush()
    })
  }

  public idle(): Promise<void> {
    if (this.destroyed || this.renderer.isDestroyed) {
      return Promise.resolve()
    }

    return this.renderer.idle().catch(() => {})
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.flush()
    this.notifyClose()
  }

  public requestExit(): boolean {
    return this.handleExit()
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
    this.seen.clear()
  }

  private notifyClose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const fn of [...this.closes]) {
      fn()
    }
  }

  private setStatus = (status: string): void => {
    this.patch({ status })
  }

  private applyHeight(): void {
    const type = this.view().type
    const height =
      type === "permission"
        ? this.base + PERMISSION_ROWS
        : type === "question"
          ? this.base + QUESTION_ROWS
          : Math.max(this.base + TEXTAREA_MIN_ROWS, Math.min(this.base + TEXTAREA_MAX_ROWS, this.base + this.rows))

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height
    }
  }

  private syncRows = (value: number): void => {
    if (this.destroyed || this.renderer.isDestroyed) {
      return
    }

    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(TEXTAREA_MAX_ROWS, value))
    if (rows === this.rows) {
      return
    }

    this.rows = rows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private handlePrompt = (text: string): boolean => {
    if (this.isClosed) {
      return false
    }

    if (this.state().first) {
      this.patch({ first: false })
    }

    if (this.prompts.size === 0) {
      this.patch({ status: "input queue unavailable" })
      return false
    }

    for (const fn of [...this.prompts]) {
      fn(text)
    }

    return true
  }

  private handlePermissionReply = async (input: PermissionReply): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onPermissionReply(input)
  }

  private handleQuestionReply = async (input: QuestionReply): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onQuestionReply(input)
  }

  private handleQuestionReject = async (input: QuestionReject): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onQuestionReject(input)
  }

  private handleCycle = (): void => {
    const result = this.options.onCycleVariant?.()
    if (!result) {
      this.patch({ status: "no variants available" })
      return
    }

    const patch: FooterPatch = {
      status: result.status ?? "variant updated",
    }

    if (result.modelLabel) {
      patch.model = result.modelLabel
    }

    this.patch(patch)
  }

  private clearInterruptTimer(): void {
    if (!this.interruptTimeout) {
      return
    }

    clearTimeout(this.interruptTimeout)
    this.interruptTimeout = undefined
  }

  private armInterruptTimer(): void {
    this.clearInterruptTimer()
    this.interruptTimeout = setTimeout(() => {
      this.interruptTimeout = undefined
      if (this.destroyed || this.renderer.isDestroyed || this.state().phase !== "running") {
        return
      }

      this.patch({ interrupt: 0 })
    }, 5000)
  }

  private clearExitTimer(): void {
    if (!this.exitTimeout) {
      return
    }

    clearTimeout(this.exitTimeout)
    this.exitTimeout = undefined
  }

  private armExitTimer(): void {
    this.clearExitTimer()
    this.exitTimeout = setTimeout(() => {
      this.exitTimeout = undefined
      if (this.destroyed || this.renderer.isDestroyed || this.isClosed) {
        return
      }

      this.patch({ exit: 0 })
    }, 5000)
  }

  private handleInterrupt = (): boolean => {
    if (this.isClosed || this.state().phase !== "running") {
      return false
    }

    const next = this.state().interrupt + 1
    this.patch({ interrupt: next })

    if (next < 2) {
      this.armInterruptTimer()
      this.patch({ status: `${this.interruptHint} again to interrupt` })
      return true
    }

    this.clearInterruptTimer()
    this.patch({ interrupt: 0, status: "interrupting" })
    this.options.onInterrupt?.()
    return true
  }

  private handleExit = (): boolean => {
    if (this.isClosed) {
      return true
    }

    this.clearInterruptTimer()
    const next = this.state().exit + 1
    this.patch({ exit: next, interrupt: 0 })

    if (next < 2) {
      this.armExitTimer()
      this.patch({ status: "Press Ctrl-c again to exit" })
      return true
    }

    this.clearExitTimer()
    this.patch({ exit: 0, status: "exiting" })
    this.close()
    this.options.onExit?.()
    return true
  }

  private handleDestroy = (): void => {
    if (this.destroyed) {
      return
    }

    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearInterruptTimer()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
    this.seen.clear()
  }

  private flush(): void {
    if (this.destroyed || this.renderer.isDestroyed || this.queue.length === 0) {
      this.queue.length = 0
      return
    }

    for (const item of this.queue.splice(0)) {
      if (
        item.phase !== "progress" ||
        (item.kind !== "assistant" && item.kind !== "reasoning") ||
        typeof item.partID !== "string" ||
        item.partID.length === 0
      ) {
        this.renderer.writeToScrollback(
          entryWriter(item, this.options.theme.entry, { diffStyle: this.options.diffStyle }),
        )
        continue
      }

      const part = item.partID
      const first = !this.seen.has(part)
      this.seen.add(part)

      if (!first) {
        this.renderer.writeToScrollback(
          entryWriter(item, this.options.theme.entry, { diffStyle: this.options.diffStyle }),
        )
        continue
      }

      this.renderer.writeToScrollback(spacerWriter())
      this.renderer.writeToScrollback(
        entryWriter(item, this.options.theme.entry, { diffStyle: this.options.diffStyle }),
      )
    }
  }
}
