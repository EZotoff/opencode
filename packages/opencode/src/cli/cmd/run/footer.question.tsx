/** @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import {
  createQuestionBodyState,
  questionConfirm,
  questionCustom,
  questionHint,
  questionInfo,
  questionInput,
  questionMove,
  questionOther,
  questionPicked,
  questionReject,
  questionSave,
  questionSelect,
  questionSetEditing,
  questionSetSelected,
  questionSetSubmitting,
  questionSetTab,
  questionSingle,
  questionStoreCustom,
  questionSubmit,
  questionSync,
  questionTabs,
  questionTotal,
  type QuestionBodyState,
} from "./question.shared"
import type { RunFooterTheme } from "./theme"
import type { QuestionReject, QuestionReply } from "./types"

type Area = {
  isDestroyed: boolean
  plainText: string
  cursorOffset: number
  setText(text: string): void
  focus(): void
}

export function RunQuestionBody(props: {
  request: QuestionRequest
  theme: RunFooterTheme
  onReply: (input: QuestionReply) => void | Promise<void>
  onReject: (input: QuestionReject) => void | Promise<void>
}) {
  const [state, setState] = createSignal(createQuestionBodyState(props.request.id))
  const single = createMemo(() => questionSingle(props.request))
  const confirm = createMemo(() => questionConfirm(props.request, state()))
  const info = createMemo(() => questionInfo(props.request, state()))
  const input = createMemo(() => questionInput(state()))
  const other = createMemo(() => questionOther(props.request, state()))
  const picked = createMemo(() => questionPicked(state()))
  const disabled = createMemo(() => state().submitting)
  let area: Area | undefined

  createEffect(() => {
    setState((prev) => questionSync(prev, props.request.id))
  })

  const setTab = (tab: number) => {
    setState((prev) => questionSetTab(prev, tab))
  }

  const move = (dir: -1 | 1) => {
    setState((prev) => questionMove(prev, props.request, dir))
  }

  const beginReply = async (input: QuestionReply) => {
    setState((prev) => questionSetSubmitting(prev, true))

    try {
      await props.onReply(input)
    } catch {
      setState((prev) => questionSetSubmitting(prev, false))
    }
  }

  const beginReject = async (input: QuestionReject) => {
    setState((prev) => questionSetSubmitting(prev, true))

    try {
      await props.onReject(input)
    } catch {
      setState((prev) => questionSetSubmitting(prev, false))
    }
  }

  const saveCustom = () => {
    const cur = state()
    const next = questionSave(cur, props.request)
    if (next.state !== cur) {
      setState(next.state)
    }

    if (!next.reply) {
      return
    }

    void beginReply(next.reply)
  }

  const choose = (selected: number) => {
    const base = state()
    const cur = questionSetSelected(base, selected)
    const next = questionSelect(cur, props.request)
    if (next.state !== base) {
      setState(next.state)
    }

    if (!next.reply) {
      return
    }

    void beginReply(next.reply)
  }

  const select = () => {
    const cur = state()
    const next = questionSelect(cur, props.request)
    if (next.state !== cur) {
      setState(next.state)
    }

    if (!next.reply) {
      return
    }

    void beginReply(next.reply)
  }

  const submit = () => {
    void beginReply(questionSubmit(props.request, state()))
  }

  const reject = () => {
    void beginReject(questionReject(props.request))
  }

  useKeyboard((event) => {
    const cur = state()
    if (cur.submitting) {
      event.preventDefault()
      return
    }

    if (cur.editing) {
      if (event.name === "escape") {
        setState((prev) => questionSetEditing(prev, false))
        event.preventDefault()
        return
      }

      if (event.name === "return" && !event.shift && !event.ctrl && !event.meta) {
        saveCustom()
        event.preventDefault()
      }
      return
    }

    if (!single() && (event.name === "left" || event.name === "h")) {
      setTab((cur.tab - 1 + questionTabs(props.request)) % questionTabs(props.request))
      event.preventDefault()
      return
    }

    if (!single() && (event.name === "right" || event.name === "l")) {
      setTab((cur.tab + 1) % questionTabs(props.request))
      event.preventDefault()
      return
    }

    if (!single() && event.name === "tab") {
      const dir = event.shift ? -1 : 1
      setTab((cur.tab + dir + questionTabs(props.request)) % questionTabs(props.request))
      event.preventDefault()
      return
    }

    if (questionConfirm(props.request, cur)) {
      if (event.name === "return") {
        submit()
        event.preventDefault()
        return
      }

      if (event.name === "escape") {
        reject()
        event.preventDefault()
      }
      return
    }

    const total = questionTotal(props.request, cur)
    const max = Math.min(total, 9)
    const digit = Number(event.name)
    if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
      choose(digit - 1)
      event.preventDefault()
      return
    }

    if (event.name === "up" || event.name === "k") {
      move(-1)
      event.preventDefault()
      return
    }

    if (event.name === "down" || event.name === "j") {
      move(1)
      event.preventDefault()
      return
    }

    if (event.name === "return") {
      select()
      event.preventDefault()
      return
    }

    if (event.name === "escape") {
      reject()
      event.preventDefault()
    }
  })

  createEffect(() => {
    if (!state().editing || !area || area.isDestroyed) {
      return
    }

    if (area.plainText !== input()) {
      area.setText(input())
      area.cursorOffset = input().length
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || !state().editing) {
        return
      }

      area.focus()
      area.cursorOffset = area.plainText.length
    })
  })

  return (
    <box id="run-direct-footer-question-body" width="100%" height="100%" flexDirection="column" gap={1}>
      <Show when={!single()}>
        <box id="run-direct-footer-question-tabs" flexDirection="row" gap={1} flexShrink={0}>
          <For each={props.request.questions}>
            {(item, index) => {
              const active = () => state().tab === index()
              const answered = () => (state().answers[index()]?.length ?? 0) > 0
              return (
                <box
                  id={`run-direct-footer-question-tab-${index()}`}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() ? props.theme.highlight : props.theme.line}
                  onMouseUp={() => {
                    if (!disabled()) setTab(index())
                  }}
                >
                  <text fg={active() ? props.theme.surface : answered() ? props.theme.text : props.theme.muted}>
                    {item.header}
                  </text>
                </box>
              )
            }}
          </For>
          <box
            id="run-direct-footer-question-tab-confirm"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={confirm() ? props.theme.highlight : props.theme.line}
            onMouseUp={() => {
              if (!disabled()) setTab(props.request.questions.length)
            }}
          >
            <text fg={confirm() ? props.theme.surface : props.theme.muted}>Confirm</text>
          </box>
        </box>
      </Show>

      <box width="100%" flexGrow={1} flexShrink={1}>
        <Show
          when={!confirm()}
          fallback={
            <scrollbox
              width="100%"
              height="100%"
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: props.theme.surface,
                  foregroundColor: props.theme.line,
                },
              }}
            >
              <box width="100%" flexDirection="column" gap={1}>
                <text fg={props.theme.text}>Review</text>
                <For each={props.request.questions}>
                  {(item, index) => {
                    const value = () => state().answers[index()]?.join(", ") ?? ""
                    return (
                      <text fg={value() ? props.theme.text : props.theme.muted} wrapMode="word">
                        {item.header}: {value() || "(not answered)"}
                      </text>
                    )
                  }}
                </For>
              </box>
            </scrollbox>
          }
        >
          <scrollbox
            width="100%"
            height="100%"
            verticalScrollbarOptions={{
              trackOptions: {
                backgroundColor: props.theme.surface,
                foregroundColor: props.theme.line,
              },
            }}
          >
            <box width="100%" flexDirection="column" gap={1}>
              <text fg={props.theme.text} wrapMode="word">
                {info()?.question}
                {info()?.multiple ? " (select all that apply)" : ""}
              </text>

              <For each={info()?.options ?? []}>
                {(item, index) => {
                  const active = () => state().selected === index()
                  const selected = () => state().answers[state().tab]?.includes(item.label) ?? false
                  return (
                    <box
                      id={`run-direct-footer-question-option-${index()}`}
                      flexDirection="column"
                      gap={0}
                      onMouseUp={() => {
                        if (!disabled()) {
                          choose(index())
                        }
                      }}
                    >
                      <box backgroundColor={active() ? props.theme.line : undefined} flexDirection="row" gap={1}>
                        <text fg={active() ? props.theme.highlight : props.theme.muted}>{`${index() + 1}.`}</text>
                        <text fg={active() ? props.theme.highlight : selected() ? props.theme.text : props.theme.text}>
                          {info()?.multiple ? `[${selected() ? "x" : " "}] ${item.label}` : item.label}
                        </text>
                      </box>
                      <text fg={props.theme.muted} wrapMode="word">
                        {item.description}
                      </text>
                    </box>
                  )
                }}
              </For>

              <Show when={questionCustom(props.request, state())}>
                <box
                  id="run-direct-footer-question-option-custom"
                  flexDirection="column"
                  gap={0}
                  onMouseUp={() => {
                    if (!disabled()) {
                      choose(info()?.options.length ?? 0)
                    }
                  }}
                >
                  <box backgroundColor={other() ? props.theme.line : undefined} flexDirection="row" gap={1}>
                    <text
                      fg={other() ? props.theme.highlight : props.theme.muted}
                    >{`${(info()?.options.length ?? 0) + 1}.`}</text>
                    <text fg={other() ? props.theme.highlight : picked() ? props.theme.text : props.theme.text}>
                      {info()?.multiple ? `[${picked() ? "x" : " "}] Type your own answer` : "Type your own answer"}
                    </text>
                  </box>
                  <Show
                    when={state().editing}
                    fallback={
                      <Show when={input()}>
                        <text fg={props.theme.muted}>{input()}</text>
                      </Show>
                    }
                  >
                    <textarea
                      id="run-direct-footer-question-custom"
                      width="100%"
                      minHeight={1}
                      maxHeight={4}
                      wrapMode="word"
                      placeholder="Type your own answer"
                      placeholderColor={props.theme.muted}
                      textColor={props.theme.text}
                      focusedTextColor={props.theme.text}
                      backgroundColor={props.theme.surface}
                      focusedBackgroundColor={props.theme.surface}
                      cursorColor={props.theme.text}
                      focused={!disabled()}
                      onContentChange={() => {
                        if (!area || area.isDestroyed || disabled()) {
                          return
                        }

                        const text = area.plainText
                        setState((prev) => questionStoreCustom(prev, prev.tab, text))
                      }}
                      ref={(item) => {
                        area = item as Area
                      }}
                    />
                  </Show>
                </box>
              </Show>
            </box>
          </scrollbox>
        </Show>
      </box>

      <text id="run-direct-footer-question-hint" fg={props.theme.muted} wrapMode="word" flexShrink={0}>
        {questionHint(props.request, state())}
      </text>
    </box>
  )
}
