/** @jsxImportSource @opentui/solid */

import {
  SyntaxStyle,
  TextAttributes,
  type ColorInput,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
} from "@opentui/core"
import { createScrollbackWriter, type JSX } from "@opentui/solid"
import { For, Show } from "solid-js"
import { Filesystem } from "../../../util/filesystem"
import { toolDiffView, toolFiletype, toolFrame, toolSnapshot } from "./tool"
import { clean, normalizeEntry } from "./scrollback.format"
import { RUN_THEME_FALLBACK, type RunEntryTheme } from "./theme"
import type { ScrollbackOptions, StreamCommit } from "./types"

type ToolDict = Record<string, unknown>

function dict(v: unknown): ToolDict {
  if (!v || typeof v !== "object") {
    return {}
  }

  return v as ToolDict
}

function text(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function num(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return
  }

  return v
}

function diagnostics(meta: ToolDict, file: string): string[] {
  const all = dict(meta.diagnostics)
  const key = Filesystem.normalizePath(file)
  const list = arr(all[key]).map(dict)
  return list
    .filter((item) => item.severity === 1)
    .slice(0, 3)
    .map((item) => {
      const range = dict(item.range)
      const start = dict(range.start)
      const line = num(start.line)
      const char = num(start.character)
      const msg = text(item.message)
      if (line === undefined || char === undefined) {
        return `Error ${msg}`.trim()
      }

      return `Error [${line + 1}:${char + 1}] ${msg}`.trim()
    })
}

type Flags = {
  startOnNewLine: boolean
  trailingNewline: boolean
}

type Paint = {
  fg: ColorInput
  attrs?: number
}

type CodeInput = {
  title: string
  content: string
  filetype?: string
  diagnostics: string[]
}

type DiffInput = {
  title: string
  diff?: string
  filetype?: string
  deletions?: number
  diagnostics: string[]
}

type TaskInput = {
  title: string
  rows: string[]
  tail: string
}

type TodoInput = {
  items: Array<{
    status: string
    content: string
  }>
  tail: string
}

type QuestionInput = {
  items: Array<{
    question: string
    answer: string
  }>
  tail: string
}

type Measure = {
  widthColsMax: number
}

type MeasureNode = {
  textBufferView?: {
    measureForDimensions(width: number, height: number): Measure | null
  }
  getChildren?: () => unknown[]
}

let syntax: SyntaxStyle | undefined

function codeStyle() {
  syntax ??= SyntaxStyle.create()
  return syntax
}

function failed(commit: StreamCommit): boolean {
  return commit.kind === "tool" && (commit.toolState === "error" || commit.part?.state.status === "error")
}

function look(commit: StreamCommit, theme: RunEntryTheme): Paint {
  if (commit.kind === "user") {
    return {
      fg: theme.user.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (failed(commit)) {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.phase === "final") {
    return {
      fg: theme.system.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "assistant") {
    return { fg: theme.assistant.body }
  }

  if (commit.kind === "reasoning") {
    return {
      fg: theme.reasoning.body,
      attrs: TextAttributes.DIM,
    }
  }

  if (commit.kind === "error") {
    return {
      fg: theme.error.body,
      attrs: TextAttributes.BOLD,
    }
  }

  if (commit.kind === "tool") {
    return { fg: theme.tool.body }
  }

  return { fg: theme.system.body }
}

function cols(ctx: ScrollbackRenderContext): number {
  return Math.max(1, Math.trunc(ctx.width))
}

function leaf(node: unknown): MeasureNode | undefined {
  if (!node || typeof node !== "object") {
    return
  }

  const next = node as MeasureNode
  if (next.textBufferView) {
    return next
  }

  const list = next.getChildren?.() ?? []
  for (const child of list) {
    const out = leaf(child)
    if (out) {
      return out
    }
  }
}

function fit(snapshot: ScrollbackSnapshot, ctx: ScrollbackRenderContext) {
  const node = leaf(snapshot.root)
  const width = cols(ctx)
  const box = node?.textBufferView?.measureForDimensions(width, Math.max(1, snapshot.height ?? 1))
  const rowColumns = Math.max(1, Math.min(width, box?.widthColsMax ?? 0))

  snapshot.width = rowColumns
  snapshot.rowColumns = rowColumns
  return snapshot
}

function full(node: () => JSX.Element, ctx: ScrollbackRenderContext, flags: Flags) {
  return createScrollbackWriter(node, {
    width: cols(ctx),
    rowColumns: cols(ctx),
    startOnNewLine: flags.startOnNewLine,
    trailingNewline: flags.trailingNewline,
  })(ctx)
}

function TextEntry(props: { body: string; fg: ColorInput; attrs?: number }) {
  return (
    <text width="100%" wrapMode="word" fg={props.fg} attributes={props.attrs}>
      {props.body}
    </text>
  )
}

function ReasoningEntry(props: { body: string; theme: RunEntryTheme }) {
  return (
    <code
      width="100%"
      filetype="markdown"
      drawUnstyledText={false}
      streaming={true}
      syntaxStyle={codeStyle()}
      content={props.body}
      conceal={false}
      wrapMode="word"
      fg={props.theme.reasoning.body}
    />
  )
}

function Diagnostics(props: { theme: RunEntryTheme; lines: string[] }) {
  return (
    <Show when={props.lines.length > 0}>
      <box>
        <For each={props.lines}>{(line) => <text fg={props.theme.error.body}>{line}</text>}</For>
      </box>
    </Show>
  )
}

function BlockTool(props: { theme: RunEntryTheme; title: string; children: JSX.Element }) {
  return (
    <box
      border={["left"]}
      borderColor={props.theme.system.body}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      gap={1}
    >
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.title}
      </text>
      {props.children}
    </box>
  )
}

function CodeTool(props: { theme: RunEntryTheme; data: CodeInput }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <line_number fg={props.theme.system.body} minWidth={3} paddingRight={1}>
        <code
          conceal={false}
          fg={props.theme.assistant.body}
          filetype={props.data.filetype}
          syntaxStyle={codeStyle()}
          content={props.data.content}
          drawUnstyledText={true}
          wrapMode="word"
        />
      </line_number>
      <Diagnostics theme={props.theme} lines={props.data.diagnostics} />
    </BlockTool>
  )
}

function DiffTool(props: { theme: RunEntryTheme; data: DiffInput; view: "unified" | "split" }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <Show
        when={props.data.diff?.trim()}
        fallback={
          <text fg={props.theme.error.body}>
            -{props.data.deletions ?? 0} line{props.data.deletions === 1 ? "" : "s"}
          </text>
        }
      >
        <box paddingLeft={1}>
          <diff
            diff={props.data.diff ?? ""}
            view={props.view}
            filetype={props.data.filetype}
            syntaxStyle={codeStyle()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={props.theme.assistant.body}
          />
        </box>
      </Show>
      <Diagnostics theme={props.theme} lines={props.data.diagnostics} />
    </BlockTool>
  )
}

function TaskTool(props: { theme: RunEntryTheme; data: TaskInput }) {
  return (
    <BlockTool theme={props.theme} title={props.data.title}>
      <box>
        <For each={props.data.rows}>{(line) => <text fg={props.theme.assistant.body}>{line}</text>}</For>
      </box>
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
    </BlockTool>
  )
}

function todoMark(status: string): string {
  if (status === "completed") {
    return "[x]"
  }
  if (status === "in_progress") {
    return "[>]"
  }
  if (status === "cancelled") {
    return "[-]"
  }
  return "[ ]"
}

function TodoTool(props: { theme: RunEntryTheme; data: TodoInput }) {
  return (
    <BlockTool theme={props.theme} title="# Todos">
      <box>
        <For each={props.data.items}>
          {(item) => (
            <text fg={props.theme.assistant.body}>
              {todoMark(item.status)} {item.content}
            </text>
          )}
        </For>
      </box>
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
    </BlockTool>
  )
}

function QuestionTool(props: { theme: RunEntryTheme; data: QuestionInput }) {
  return (
    <BlockTool theme={props.theme} title="# Questions">
      <text fg={props.theme.system.body} attributes={TextAttributes.DIM}>
        {props.data.tail}
      </text>
      <box gap={1}>
        <For each={props.data.items}>
          {(item) => (
            <box flexDirection="column">
              <text fg={props.theme.system.body}>{item.question}</text>
              <text fg={props.theme.assistant.body}>{item.answer}</text>
            </box>
          )}
        </For>
      </box>
    </BlockTool>
  )
}

function textWriter(body: string, commit: StreamCommit, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  const style = look(commit, theme)
  return (ctx) =>
    fit(
      createScrollbackWriter(() => <TextEntry body={body} fg={style.fg} attrs={style.attrs} />, {
        width: cols(ctx),
        startOnNewLine: flags.startOnNewLine,
        trailingNewline: flags.trailingNewline,
      })(ctx),
      ctx,
    )
}

function reasoningWriter(body: string, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) =>
    fit(
      createScrollbackWriter(() => <ReasoningEntry body={body} theme={theme} />, {
        width: cols(ctx),
        startOnNewLine: flags.startOnNewLine,
        trailingNewline: flags.trailingNewline,
      })(ctx),
      ctx,
    )
}

function blankWriter(): ScrollbackWriter {
  return (ctx) => {
    const snapshot = createScrollbackWriter(() => <text width="100%" />, {
      width: cols(ctx),
      startOnNewLine: false,
      trailingNewline: true,
    })(ctx)
    snapshot.width = 0
    snapshot.rowColumns = 0
    return snapshot
  }
}

function textBlockWriter(body: string, theme: RunEntryTheme): ScrollbackWriter {
  return (ctx) =>
    full(() => <TextEntry body={body.endsWith("\n") ? body : `${body}\n`} fg={theme.system.body} />, ctx, {
      startOnNewLine: true,
      trailingNewline: false,
    })
}

function codeWriter(data: CodeInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <CodeTool theme={theme} data={data} />, ctx, flags)
}

function diffWriter(
  list: DiffInput[],
  theme: RunEntryTheme,
  flags: Flags,
  view: "unified" | "split",
): ScrollbackWriter {
  return (ctx) =>
    full(
      () => (
        <box flexDirection="column" gap={1}>
          <For each={list}>{(data) => <DiffTool theme={theme} data={data} view={view} />}</For>
        </box>
      ),
      ctx,
      flags,
    )
}

function taskWriter(data: TaskInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <TaskTool theme={theme} data={data} />, ctx, flags)
}

function todoWriter(data: TodoInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <TodoTool theme={theme} data={data} />, ctx, flags)
}

function questionWriter(data: QuestionInput, theme: RunEntryTheme, flags: Flags): ScrollbackWriter {
  return (ctx) => full(() => <QuestionTool theme={theme} data={data} />, ctx, flags)
}

function flags(commit: StreamCommit): Flags {
  if (commit.kind === "user") {
    return {
      startOnNewLine: true,
      trailingNewline: false,
    }
  }

  if (commit.kind === "tool") {
    if (commit.phase === "progress") {
      return {
        startOnNewLine: false,
        trailingNewline: false,
      }
    }

    return {
      startOnNewLine: true,
      trailingNewline: true,
    }
  }

  if (commit.kind === "assistant" || commit.kind === "reasoning") {
    if (commit.phase === "progress") {
      return {
        startOnNewLine: false,
        trailingNewline: false,
      }
    }

    return {
      startOnNewLine: true,
      trailingNewline: true,
    }
  }

  return {
    startOnNewLine: true,
    trailingNewline: true,
  }
}

export function textEntryWriter(commit: StreamCommit, theme: RunEntryTheme): ScrollbackWriter {
  const body = normalizeEntry(commit)
  const snap = flags(commit)

  if (commit.kind === "reasoning" && commit.phase === "progress") {
    return reasoningWriter(body, theme, snap)
  }

  return textWriter(body, commit, theme, snap)
}

export function snapEntryWriter(commit: StreamCommit, theme: RunEntryTheme, opts: ScrollbackOptions): ScrollbackWriter {
  const snap = toolSnapshot(commit, clean(commit.text))
  if (!snap) {
    return textEntryWriter(commit, theme)
  }

  const info = toolFrame(commit, clean(commit.text))
  const style = flags(commit)

  if (snap.kind === "code") {
    return codeWriter(
      {
        title: snap.title,
        content: snap.content,
        filetype: toolFiletype(snap.file),
        diagnostics: diagnostics(info.meta, snap.file ?? ""),
      },
      theme,
      style,
    )
  }

  if (snap.kind === "diff") {
    if (snap.items.length === 0) {
      return textEntryWriter(commit, theme)
    }

    const list = snap.items
      .map((item) => {
        if (!item.diff.trim()) {
          return
        }

        return {
          title: item.title,
          diff: item.diff,
          filetype: toolFiletype(item.file),
          deletions: item.deletions,
          diagnostics: diagnostics(info.meta, item.file ?? ""),
        }
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))

    if (list.length === 0) {
      return textEntryWriter(commit, theme)
    }

    return (ctx) => diffWriter(list, theme, style, toolDiffView(ctx.width, opts.diffStyle))(ctx)
  }

  if (snap.kind === "task") {
    return taskWriter(
      {
        title: snap.title,
        rows: snap.rows,
        tail: snap.tail,
      },
      theme,
      style,
    )
  }

  if (snap.kind === "todo") {
    return todoWriter(
      {
        items: snap.items,
        tail: snap.tail,
      },
      theme,
      style,
    )
  }

  return questionWriter(
    {
      items: snap.items,
      tail: snap.tail,
    },
    theme,
    style,
  )
}

export function blockWriter(text: string, theme: RunEntryTheme = RUN_THEME_FALLBACK.entry): ScrollbackWriter {
  return textBlockWriter(clean(text), theme)
}

export function spacerWriter(): ScrollbackWriter {
  return blankWriter()
}
