/** @jsxImportSource @opentui/solid */
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import {
  createPermissionBodyState,
  permissionAlwaysLines,
  permissionCancel,
  permissionEscape,
  permissionHover,
  permissionInfo,
  permissionLabel,
  permissionOptions,
  permissionReject,
  permissionRun,
  permissionShift,
  type PermissionOption,
} from "./permission.shared"
import { toolDiffView, toolFiletype } from "./tool"
import type { RunFooterTheme } from "./theme"
import type { PermissionReply, RunDiffStyle } from "./types"

type RejectArea = {
  isDestroyed: boolean
  plainText: string
  cursorOffset: number
  setText(text: string): void
  focus(): void
}

function buttons(
  list: PermissionOption[],
  selected: PermissionOption,
  theme: RunFooterTheme,
  disabled: boolean,
  onHover: (option: PermissionOption) => void,
  onSelect: (option: PermissionOption) => void,
) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <For each={list}>
        {(option) => (
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={option === selected ? theme.highlight : theme.line}
            onMouseOver={() => {
              if (!disabled) onHover(option)
            }}
            onMouseUp={() => {
              if (!disabled) onSelect(option)
            }}
          >
            <text fg={option === selected ? theme.surface : theme.muted}>{permissionLabel(option)}</text>
          </box>
        )}
      </For>
    </box>
  )
}

function RejectField(props: {
  theme: RunFooterTheme
  text: string
  disabled: boolean
  onChange: (text: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  let area: RejectArea | undefined

  createEffect(() => {
    if (!area || area.isDestroyed) {
      return
    }

    if (area.plainText !== props.text) {
      area.setText(props.text)
      area.cursorOffset = props.text.length
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || props.disabled) {
        return
      }
      area.focus()
    })
  })

  return (
    <textarea
      id="run-direct-footer-permission-reject"
      width="100%"
      minHeight={1}
      maxHeight={3}
      wrapMode="word"
      placeholder="Tell OpenCode what to do differently"
      placeholderColor={props.theme.muted}
      textColor={props.theme.text}
      focusedTextColor={props.theme.text}
      backgroundColor={props.theme.surface}
      focusedBackgroundColor={props.theme.surface}
      cursorColor={props.theme.text}
      focused={!props.disabled}
      onContentChange={() => {
        if (!area || area.isDestroyed) {
          return
        }
        props.onChange(area.plainText)
      }}
      onKeyDown={(event) => {
        if (event.name === "escape") {
          event.preventDefault()
          props.onCancel()
          return
        }

        if (event.name === "return" && !event.meta && !event.ctrl && !event.shift) {
          event.preventDefault()
          props.onConfirm()
        }
      }}
      ref={(item) => {
        area = item as RejectArea
      }}
    />
  )
}

export function RunPermissionBody(props: {
  request: PermissionRequest
  theme: RunFooterTheme
  diffStyle?: RunDiffStyle
  onReply: (input: PermissionReply) => void | Promise<void>
}) {
  const dims = useTerminalDimensions()
  const [state, setState] = createSignal(createPermissionBodyState(props.request.id))
  const info = createMemo(() => permissionInfo(props.request))
  const ft = createMemo(() => toolFiletype(info().file))
  const view = createMemo(() => toolDiffView(dims().width, props.diffStyle))
  const opts = createMemo(() => permissionOptions(state().stage))
  const busy = createMemo(() => state().submitting)

  createEffect(() => {
    const id = props.request.id
    if (state().requestID === id) {
      return
    }

    setState(createPermissionBodyState(id))
  })

  const shift = (dir: -1 | 1) => {
    setState((prev) => permissionShift(prev, dir))
  }

  const submit = async (next: PermissionReply) => {
    setState((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onReply(next)
    } catch {
      setState((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const run = (option: PermissionOption) => {
    const cur = state()
    const next = permissionRun(cur, props.request.id, option)
    if (next.state !== cur) {
      setState(next.state)
    }

    if (!next.reply) {
      return
    }

    void submit(next.reply)
  }

  const reject = () => {
    const next = permissionReject(state(), props.request.id)
    if (!next) {
      return
    }

    void submit(next)
  }

  const cancelReject = () => {
    setState((prev) => permissionCancel(prev))
  }

  useKeyboard((event) => {
    const cur = state()
    if (cur.stage === "reject") {
      return
    }

    if (cur.submitting) {
      if (["left", "right", "h", "l", "return", "escape"].includes(event.name)) {
        event.preventDefault()
      }
      return
    }

    if (event.name === "left" || event.name === "h") {
      shift(-1)
      event.preventDefault()
      return
    }

    if (event.name === "right" || event.name === "l") {
      shift(1)
      event.preventDefault()
      return
    }

    if (event.name === "return") {
      run(state().selected)
      event.preventDefault()
      return
    }

    if (event.name !== "escape") {
      return
    }

    setState((prev) => permissionEscape(prev))
    event.preventDefault()
  })

  return (
    <box id="run-direct-footer-permission-body" width="100%" height="100%" flexDirection="column" gap={1}>
      <box flexDirection="column" gap={0} flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <text fg={props.theme.highlight}>△</text>
          <text fg={props.theme.text}>
            <Switch>
              <Match when={state().stage === "always"}>Always allow</Match>
              <Match when={state().stage === "reject"}>Reject permission</Match>
              <Match when={true}>Permission required</Match>
            </Switch>
          </text>
        </box>
        <Show when={state().stage === "permission"}>
          <box flexDirection="row" gap={1} paddingLeft={2}>
            <text fg={props.theme.muted}>{info().icon}</text>
            <text fg={props.theme.text} wrapMode="word">
              {info().title}
            </text>
          </box>
        </Show>
      </box>

      <box width="100%" flexGrow={1} flexShrink={1}>
        <Switch>
          <Match when={state().stage === "permission"}>
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
                <Show
                  when={info().diff}
                  fallback={<For each={info().lines}>{(line) => <text fg={props.theme.text}>{line}</text>}</For>}
                >
                  <diff
                    diff={info().diff!}
                    view={view()}
                    filetype={ft()}
                    showLineNumbers={true}
                    width="100%"
                    wrapMode="word"
                    fg={props.theme.text}
                    lineNumberFg={props.theme.muted}
                  />
                </Show>
                <Show when={!info().diff && info().lines.length === 0}>
                  <text fg={props.theme.muted}>No diff provided</text>
                </Show>
              </box>
            </scrollbox>
          </Match>
          <Match when={state().stage === "always"}>
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
                <For each={permissionAlwaysLines(props.request)}>
                  {(line) => <text fg={props.theme.text}>{line}</text>}
                </For>
              </box>
            </scrollbox>
          </Match>
          <Match when={state().stage === "reject"}>
            <box width="100%" height="100%" flexDirection="column" gap={1}>
              <text fg={props.theme.muted}>Tell OpenCode what to do differently</text>
              <RejectField
                theme={props.theme}
                text={state().message}
                disabled={busy()}
                onChange={(text) => {
                  setState((prev) => ({
                    ...prev,
                    message: text,
                  }))
                }}
                onConfirm={reject}
                onCancel={cancelReject}
              />
            </box>
          </Match>
        </Switch>
      </box>

      <Switch>
        <Match when={state().stage !== "reject"}>
          <box flexDirection="column" gap={1} flexShrink={0}>
            {buttons(
              opts(),
              state().selected,
              props.theme,
              busy(),
              (option) => {
                setState((prev) => permissionHover(prev, option))
              },
              run,
            )}
            <text fg={props.theme.muted} wrapMode="word">
              <Show
                when={busy()}
                fallback={
                  state().stage === "always"
                    ? "⇆ select   enter confirm   esc cancel"
                    : "⇆ select   enter confirm   esc reject"
                }
              >
                Waiting for permission event...
              </Show>
            </text>
          </box>
        </Match>
        <Match when={true}>
          <text fg={props.theme.muted} wrapMode="word" flexShrink={0}>
            <Show when={busy()} fallback="enter confirm   esc cancel">
              Waiting for permission event...
            </Show>
          </text>
        </Match>
      </Switch>
    </box>
  )
}
