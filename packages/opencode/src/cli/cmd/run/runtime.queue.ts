import { Locale } from "../../../util/locale"
import { isExitCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  onPrompt?: () => void
  run: (prompt: string, signal: AbortSignal) => Promise<void>
}

export async function runPromptQueue(input: QueueInput): Promise<void> {
  const q: string[] = []
  let turn = 0
  let busy = false
  let closed = input.footer.isClosed
  let ctrl: AbortController | undefined
  let stop: (() => void) | undefined
  let err: unknown
  let hasErr = false
  let done: (() => void) | undefined
  const wait = new Promise<void>((resolve) => {
    done = resolve
  })
  const until = new Promise<void>((resolve) => {
    stop = resolve
  })

  const fail = (error: unknown) => {
    err = error
    hasErr = true
    done?.()
    done = undefined
  }

  const finish = () => {
    if (!closed || busy) {
      return
    }

    done?.()
    done = undefined
  }

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const pump = async () => {
    if (busy || closed) {
      return
    }

    busy = true

    try {
      while (!closed && q.length > 0) {
        const prompt = q.shift()
        if (!prompt) {
          continue
        }

        emit(
          {
            type: "turn.send",
            queue: q.length,
          },
          {
            phase: "running",
            status: "sending prompt",
            queue: q.length,
          },
        )
        const start = Date.now()
        const next = new AbortController()
        ctrl = next
        try {
          const task = input.run(prompt, next.signal).then(
            () => ({ type: "done" as const }),
            (error) => ({ type: "error" as const, error }),
          )
          await input.footer.idle()
          const text = turn === 0 ? prompt : `\n${prompt}`
          turn += 1
          const commit = { kind: "user", text, phase: "start", source: "system" } as const
          input.trace?.write("ui.commit", commit)
          input.footer.append(commit)
          const out = await Promise.race([task, until.then(() => ({ type: "closed" as const }))])
          if (out.type === "closed") {
            next.abort()
            break
          }

          if (out.type === "error") {
            throw out.error
          }
        } finally {
          if (ctrl === next) {
            ctrl = undefined
          }
          const duration = Locale.duration(Math.max(0, Date.now() - start))
          emit(
            {
              type: "turn.duration",
              duration,
            },
            {
              duration,
            },
          )
        }
      }
    } finally {
      busy = false
      emit(
        {
          type: "turn.idle",
          queue: q.length,
        },
        {
          phase: "idle",
          status: "",
          queue: q.length,
        },
      )
      finish()
    }
  }

  const push = (text: string) => {
    const prompt = text
    if (!prompt.trim() || closed) {
      return
    }

    if (isExitCommand(prompt)) {
      input.footer.close()
      return
    }

    input.onPrompt?.()
    q.push(prompt)
    emit(
      {
        type: "queue",
        queue: q.length,
      },
      {
        queue: q.length,
      },
    )
    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    void pump().catch(fail)
  }

  const offPrompt = input.footer.onPrompt((text) => {
    push(text)
  })
  const offClose = input.footer.onClose(() => {
    closed = true
    q.length = 0
    ctrl?.abort()
    stop?.()
    finish()
  })

  try {
    if (closed) {
      return
    }

    push(input.initialInput ?? "")
    await pump()

    if (!closed) {
      await wait
    }

    if (hasErr) {
      throw err
    }
  } finally {
    offPrompt()
    offClose()
  }
}
