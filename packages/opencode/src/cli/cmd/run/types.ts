import type { OpencodeClient, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"

export type RunFilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type PromptModel = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

export type RunInput = {
  sdk: OpencodeClient
  sessionID: string
  sessionTitle?: string
  resume?: boolean
  agent: string | undefined
  model: PromptModel | undefined
  variant: string | undefined
  files: RunFilePart[]
  initialInput?: string
  thinking: boolean
  demo?: RunDemo
  demoText?: string
}

export type RunDemo = "on" | "permission" | "question" | "mix" | "text"

export type EntryKind = "system" | "user" | "assistant" | "reasoning" | "tool" | "error"

export type FooterPhase = "idle" | "running"

export type FooterState = {
  phase: FooterPhase
  status: string
  queue: number
  model: string
  duration: string
  usage: string
  first: boolean
  interrupt: number
  exit: number
}

export type FooterPatch = Partial<FooterState>

export type RunDiffStyle = "auto" | "stacked"

export type ScrollbackOptions = {
  diffStyle?: RunDiffStyle
}

export type FooterView =
  | { type: "prompt" }
  | { type: "permission"; request: PermissionRequest }
  | { type: "question"; request: QuestionRequest }

export type FooterOutput = {
  patch?: FooterPatch
  view?: FooterView
}

export type FooterEvent =
  | {
      type: "queue"
      queue: number
    }
  | {
      type: "first"
      first: boolean
    }
  | {
      type: "model"
      model: string
    }
  | {
      type: "turn.send"
      queue: number
    }
  | {
      type: "turn.wait"
    }
  | {
      type: "turn.idle"
      queue: number
    }
  | {
      type: "turn.duration"
      duration: string
    }
  | {
      type: "stream.patch"
      patch: FooterPatch
    }
  | {
      type: "stream.view"
      view: FooterView
    }

export type PermissionReply = Parameters<OpencodeClient["permission"]["reply"]>[0]

export type QuestionReply = Parameters<OpencodeClient["question"]["reply"]>[0]

export type QuestionReject = Parameters<OpencodeClient["question"]["reject"]>[0]

export type FooterKeybinds = {
  leader: string
  variantCycle: string
  interrupt: string
  historyPrevious: string
  historyNext: string
  inputSubmit: string
  inputNewline: string
}

export type StreamPhase = "start" | "progress" | "final"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamToolState = "running" | "completed" | "error"

export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  source: StreamSource
  messageID?: string
  partID?: string
  tool?: string
  part?: ToolPart
  interrupted?: boolean
  toolState?: StreamToolState
  toolError?: string
}

export type FooterApi = {
  readonly isClosed: boolean
  onPrompt(fn: (text: string) => void): () => void
  onClose(fn: () => void): () => void
  event(next: FooterEvent): void
  append(commit: StreamCommit): void
  idle(): Promise<void>
  close(): void
  destroy(): void
}
