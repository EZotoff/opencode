import path from "path"
import type { Event } from "@opencode-ai/sdk/v2"
import { createSessionData, reduceSessionData, type SessionData } from "./session-data"
import { writeSessionOutput } from "./stream"
import type { FooterApi, PermissionReply, QuestionReject, QuestionReply, RunDemo } from "./types"

const KINDS = ["text", "reasoning", "bash", "write", "edit", "patch", "task", "todo", "question", "error", "mix"]

const SAMPLE_TEXT = [
  "# Demo markdown",
  "",
  "This is sample assistant output for direct mode formatting checks.",
  "It includes **bold**, _italic_, and `inline code`.",
  "",
  "- bullet: short line",
  "- bullet: long line that should wrap cleanly in narrow terminals while keeping list indentation readable",
  "- bullet: [link text](https://example.com)",
  "",
  "1. ordered item",
  "2. second ordered item",
  "",
  "> quote line for spacing and style checks",
  "",
  "```ts",
  "const sample = { ok: true, count: 42 }",
  "```",
  "",
  "| key   | value |",
  "| ----- | ----- |",
  "| alpha | one   |",
  "| beta  | two   |",
].join("\n")

type Ref = {
  msg: string
  part: string
  call: string
  tool: string
  input: Record<string, unknown>
  start: number
}

type Ask = {
  ref: Ref
}

type State = {
  id: string
  thinking: boolean
  data: SessionData
  footer: FooterApi
  limits: () => Record<string, number>
  msg: number
  part: number
  call: number
  perm: number
  ask: number
  perms: Map<string, Ref>
  asks: Map<string, Ask>
}

type Input = {
  mode: RunDemo
  text?: string
  sessionID: string
  thinking: boolean
  limits: () => Record<string, number>
  footer: FooterApi
}

function note(footer: FooterApi, text: string): void {
  footer.append({
    kind: "system",
    text,
    phase: "start",
    source: "system",
  })
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms)
      return
    }

    if (signal.aborted) {
      resolve()
      return
    }

    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done)
      resolve()
    }, ms)

    signal.addEventListener("abort", done, { once: true })
  })
}

function split(text: string): string[] {
  if (text.length <= 48) {
    return [text]
  }

  const size = Math.ceil(text.length / 3)
  return [text.slice(0, size), text.slice(size, size * 2), text.slice(size * 2)]
}

function take(state: State, key: "msg" | "part" | "call" | "perm" | "ask", prefix: string): string {
  state[key] += 1
  return `demo_${prefix}_${state[key]}`
}

function feed(state: State, event: Event): void {
  const out = reduceSessionData({
    data: state.data,
    event,
    sessionID: state.id,
    thinking: state.thinking,
    limits: state.limits(),
  })
  state.data = out.data
  writeSessionOutput(
    {
      footer: state.footer,
    },
    out,
  )
}

function open(state: State): string {
  const id = take(state, "msg", "msg")
  feed(state, {
    type: "message.updated",
    properties: {
      sessionID: state.id,
      info: {
        id,
        sessionID: state.id,
        role: "assistant",
        time: {
          created: Date.now(),
        },
        parentID: `user_${id}`,
        modelID: "demo",
        providerID: "demo",
        mode: "demo",
        agent: "demo",
        path: {
          cwd: process.cwd(),
          root: process.cwd(),
        },
        cost: 0.001,
        tokens: {
          input: 120,
          output: 320,
          reasoning: 80,
          cache: {
            read: 0,
            write: 0,
          },
        },
      },
    },
  } as Event)
  return id
}

async function emitText(state: State, body: string, signal?: AbortSignal): Promise<void> {
  const msg = open(state)
  const part = take(state, "part", "part")
  const start = Date.now()

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "text",
        text: "",
        time: {
          start,
        },
      },
    },
  } as Event)

  let next = ""
  for (const item of split(body)) {
    if (signal?.aborted) {
      return
    }

    next += item
    feed(state, {
      type: "message.part.delta",
      properties: {
        sessionID: state.id,
        messageID: msg,
        partID: part,
        field: "text",
        delta: item,
      },
    } as Event)
    await wait(45, signal)
  }

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "text",
        text: next,
        time: {
          start,
          end: Date.now(),
        },
      },
    },
  } as Event)
}

async function emitReasoning(state: State, body: string, signal?: AbortSignal): Promise<void> {
  const msg = open(state)
  const part = take(state, "part", "part")
  const start = Date.now()

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "reasoning",
        text: "",
        time: {
          start,
        },
      },
    },
  } as Event)

  let next = ""
  for (const item of split(body)) {
    if (signal?.aborted) {
      return
    }

    next += item
    feed(state, {
      type: "message.part.delta",
      properties: {
        sessionID: state.id,
        messageID: msg,
        partID: part,
        field: "text",
        delta: item,
      },
    } as Event)
    await wait(45, signal)
  }

  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: part,
        sessionID: state.id,
        messageID: msg,
        type: "reasoning",
        text: next,
        time: {
          start,
          end: Date.now(),
        },
      },
    },
  } as Event)
}

function make(state: State, tool: string, input: Record<string, unknown>): Ref {
  return {
    msg: open(state),
    part: take(state, "part", "part"),
    call: take(state, "call", "call"),
    tool,
    input,
    start: Date.now(),
  }
}

function startTool(state: State, ref: Ref, metadata: Record<string, unknown> = {}): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "running",
          input: ref.input,
          metadata,
          time: {
            start: ref.start,
          },
        },
      },
    },
  } as Event)
}

function doneTool(
  state: State,
  ref: Ref,
  output: {
    title: string
    output: string
    metadata?: Record<string, unknown>
  },
): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "completed",
          input: ref.input,
          output: output.output,
          title: output.title,
          metadata: output.metadata ?? {},
          time: {
            start: ref.start,
            end: Date.now(),
          },
        },
      },
    },
  } as Event)
}

function failTool(state: State, ref: Ref, error: string): void {
  feed(state, {
    type: "message.part.updated",
    properties: {
      sessionID: state.id,
      time: Date.now(),
      part: {
        id: ref.part,
        sessionID: state.id,
        messageID: ref.msg,
        type: "tool",
        callID: ref.call,
        tool: ref.tool,
        state: {
          status: "error",
          input: ref.input,
          error,
          metadata: {},
          time: {
            start: ref.start,
            end: Date.now(),
          },
        },
      },
    },
  } as Event)
}

function emitError(state: State, text: string): void {
  feed(state, {
    type: "session.error",
    properties: {
      sessionID: state.id,
      error: {
        name: "DemoError",
        message: text,
      },
    },
  } as unknown as Event)
}

async function emitBash(state: State, signal?: AbortSignal): Promise<void> {
  const ref = make(state, "bash", {
    command: "git status",
    workdir: process.cwd(),
    description: "Show git status",
  })
  startTool(state, ref)
  await wait(70, signal)
  doneTool(state, ref, {
    title: "git status",
    output: `${process.cwd()}\ngit status\nOn branch demo\nnothing to commit, working tree clean\n`,
    metadata: {
      exitCode: 0,
    },
  })
}

function emitWrite(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "write", {
    filePath: file,
    content: "export const demo = 42\n",
  })
  doneTool(state, ref, {
    title: "write",
    output: "",
    metadata: {},
  })
}

function emitEdit(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "edit", {
    filePath: file,
  })
  doneTool(state, ref, {
    title: "edit",
    output: "",
    metadata: {
      diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
    },
  })
}

function emitPatch(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "apply_patch", {
    patchText: "*** Begin Patch\n*** End Patch",
  })
  doneTool(state, ref, {
    title: "apply_patch",
    output: "",
    metadata: {
      files: [
        {
          type: "update",
          filePath: file,
          relativePath: "src/demo-format.ts",
          diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
          deletions: 1,
        },
        {
          type: "add",
          filePath: path.join(process.cwd(), "README-demo.md"),
          relativePath: "README-demo.md",
          diff: "@@ -0,0 +1,4 @@\n+# Demo\n+This is a generated preview file.\n",
          deletions: 0,
        },
      ],
    },
  })
}

function emitTask(state: State): void {
  const ref = make(state, "task", {
    description: "Scan run/* for reducer touchpoints",
    subagent_type: "explore",
  })
  doneTool(state, ref, {
    title: "Reducer touchpoints found",
    output: "",
    metadata: {
      toolcalls: 4,
      sessionId: "sub_demo_1",
    },
  })
}

function emitTodo(state: State): void {
  const ref = make(state, "todowrite", {
    todos: [
      {
        content: "Trigger permission UI",
        status: "completed",
      },
      {
        content: "Trigger question UI",
        status: "in_progress",
      },
      {
        content: "Tune tool formatting",
        status: "pending",
      },
    ],
  })
  doneTool(state, ref, {
    title: "todowrite",
    output: "",
    metadata: {},
  })
}

function emitQuestionTool(state: State): void {
  const ref = make(state, "question", {
    questions: [
      {
        header: "Style",
        question: "Which output style do you want to inspect?",
        options: [
          { label: "Diff", description: "Show diff block" },
          { label: "Code", description: "Show code block" },
        ],
        multiple: false,
      },
      {
        header: "Extras",
        question: "Pick extra rows",
        options: [
          { label: "Usage", description: "Add usage row" },
          { label: "Duration", description: "Add duration row" },
        ],
        multiple: true,
        custom: true,
      },
    ],
  })
  doneTool(state, ref, {
    title: "question",
    output: "",
    metadata: {
      answers: [["Diff"], ["Usage", "custom-note"]],
    },
  })
}

function emitPermission(state: State): void {
  const file = path.join(process.cwd(), "src", "demo-format.ts")
  const ref = make(state, "edit", {
    filePath: file,
    filepath: file,
    diff: "@@ -1 +1 @@\n-export const demo = 1\n+export const demo = 42\n",
  })
  startTool(state, ref)

  const id = take(state, "perm", "perm")
  state.perms.set(id, ref)

  feed(state, {
    type: "permission.asked",
    properties: {
      id,
      sessionID: state.id,
      permission: "edit",
      patterns: [file],
      metadata: {},
      always: [file],
      tool: {
        messageID: ref.msg,
        callID: ref.call,
      },
    },
  } as Event)
}

function emitQuestion(state: State): void {
  const questions = [
    {
      header: "Layout",
      question: "Which footer view should stay active while testing?",
      options: [
        { label: "Prompt", description: "Return to prompt" },
        { label: "Question", description: "Keep question open" },
      ],
      multiple: false,
    },
    {
      header: "Rows",
      question: "Pick formatting previews",
      options: [
        { label: "Diff", description: "Emit edit diff" },
        { label: "Task", description: "Emit task card" },
        { label: "Todo", description: "Emit todo card" },
      ],
      multiple: true,
      custom: true,
    },
  ]

  const ref = make(state, "question", { questions })
  startTool(state, ref)

  const id = take(state, "ask", "ask")
  state.asks.set(id, { ref })

  feed(state, {
    type: "question.asked",
    properties: {
      id,
      sessionID: state.id,
      questions,
      tool: {
        messageID: ref.msg,
        callID: ref.call,
      },
    },
  } as Event)
}

async function emitFmt(state: State, kind: string, body: string, signal?: AbortSignal): Promise<boolean> {
  if (kind === "text") {
    await emitText(state, body || SAMPLE_TEXT, signal)
    return true
  }

  if (kind === "reasoning") {
    await emitReasoning(state, body || "Planning next steps [REDACTED] while preserving reducer ordering.", signal)
    return true
  }

  if (kind === "bash") {
    await emitBash(state, signal)
    return true
  }

  if (kind === "write") {
    emitWrite(state)
    return true
  }

  if (kind === "edit") {
    emitEdit(state)
    return true
  }

  if (kind === "patch") {
    emitPatch(state)
    return true
  }

  if (kind === "task") {
    emitTask(state)
    return true
  }

  if (kind === "todo") {
    emitTodo(state)
    return true
  }

  if (kind === "question") {
    emitQuestionTool(state)
    return true
  }

  if (kind === "error") {
    emitError(state, body || "demo error event")
    return true
  }

  if (kind === "mix") {
    await emitText(state, "Demo run: assistant text block for wrap testing.", signal)
    await wait(50, signal)
    await emitReasoning(state, "Thinking through formatter edge cases [REDACTED].", signal)
    await wait(50, signal)
    await emitBash(state, signal)
    emitWrite(state)
    emitEdit(state)
    emitPatch(state)
    emitTask(state)
    emitTodo(state)
    emitQuestionTool(state)
    emitError(state, "demo mixed scenario error")
    return true
  }

  return false
}

function intro(state: State): void {
  note(
    state.footer,
    [
      "Demo slash commands enabled for interactive mode.",
      "- /permission",
      "- /question",
      `- /fmt <kind> (${KINDS.join(", ")})`,
      "Examples:",
      "- /fmt mix",
      "- /fmt text your custom text",
    ].join("\n"),
  )
}

export function createRunDemo(input: Input) {
  const state: State = {
    id: input.sessionID,
    thinking: input.thinking,
    data: createSessionData(),
    footer: input.footer,
    limits: input.limits,
    msg: 0,
    part: 0,
    call: 0,
    perm: 0,
    ask: 0,
    perms: new Map(),
    asks: new Map(),
  }

  const start = async (): Promise<void> => {
    intro(state)
    if (input.mode === "on") {
      return
    }

    if (input.mode === "permission") {
      emitPermission(state)
      return
    }

    if (input.mode === "question") {
      emitQuestion(state)
      return
    }

    if (input.mode === "mix") {
      await emitFmt(state, "mix", "")
      return
    }

    if (input.mode === "text") {
      await emitFmt(state, "text", input.text ?? SAMPLE_TEXT)
    }
  }

  const prompt = async (line: string, signal?: AbortSignal): Promise<boolean> => {
    const text = line.trim()
    if (text === "/help") {
      intro(state)
      return true
    }

    if (text === "/permission") {
      emitPermission(state)
      return true
    }

    if (text === "/question") {
      emitQuestion(state)
      return true
    }

    if (text.startsWith("/fmt")) {
      const list = text.split(/\s+/)
      const kind = (list[1] || "").toLowerCase()
      const body = list.slice(2).join(" ")
      if (!kind) {
        note(state.footer, `Pick a kind: ${KINDS.join(", ")}`)
        return true
      }

      const ok = await emitFmt(state, kind, body, signal)
      if (ok) {
        return true
      }

      note(state.footer, `Unknown kind \"${kind}\". Use: ${KINDS.join(", ")}`)
      return true
    }

    return false
  }

  const permission = (input: PermissionReply): boolean => {
    const ref = state.perms.get(input.requestID)
    if (!ref) {
      return false
    }

    state.perms.delete(input.requestID)
    feed(state, {
      type: "permission.replied",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
        reply: input.reply,
      },
    } as Event)

    if (input.reply === "reject") {
      failTool(state, ref, input.message || "permission rejected")
      return true
    }

    const diff = typeof ref.input.diff === "string" ? ref.input.diff : ""
    doneTool(state, ref, {
      title: "edit",
      output: "",
      metadata: {
        diff,
      },
    })
    return true
  }

  const questionReply = (input: QuestionReply): boolean => {
    const ask = state.asks.get(input.requestID)
    if (!ask) {
      return false
    }

    state.asks.delete(input.requestID)
    feed(state, {
      type: "question.replied",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
        answers: input.answers,
      },
    } as Event)
    doneTool(state, ask.ref, {
      title: "question",
      output: "",
      metadata: {
        answers: input.answers,
      },
    })
    return true
  }

  const questionReject = (input: QuestionReject): boolean => {
    const ask = state.asks.get(input.requestID)
    if (!ask) {
      return false
    }

    state.asks.delete(input.requestID)
    feed(state, {
      type: "question.rejected",
      properties: {
        sessionID: state.id,
        requestID: input.requestID,
      },
    } as Event)
    failTool(state, ask.ref, "question rejected")
    return true
  }

  return {
    start,
    prompt,
    permission,
    questionReply,
    questionReject,
  }
}
