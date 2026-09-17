// Shell-hygiene helpers for the bash tool boundary (Task 6):
//   - timeout default/cap resolution (clamp semantics, never reject)
//   - warning-only detach-pattern detection
//
// Warnings are advisory ONLY: they never block, gate, or alter execution.

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000
export const MAX_TIMEOUT_MS = 30 * 60 * 1000

export function resolveTimeout(requested: number | undefined, defaultMs: number, maxMs: number) {
  const wanted = requested ?? defaultMs
  const timeout = Math.min(wanted, maxMs)
  return {
    timeout,
    ...(wanted > maxMs ? { clampedFrom: wanted } : {}),
  }
}

const DETACH = /(^|\s)(nohup|setsid)\b|\s&\s|&\s*$/
const FOLLOW = /\btail\s+[^|;&]*\b[a-zA-Z]*f[a-zA-Z]*\b/
const SLEEP = /\bsleep\s+(\d+(?:\.\d+)?)(ms|min|m|h|d|s)?\b/g

const DURABLE_RUN_NOTE =
  "The bash tool kills its whole process group when the call completes or times out — backgrounded work does NOT outlive the call (by design). Use 'opencode durable-run' for work that must outlive this tool call."

const sleepSeconds = (n: number, suffix: string | undefined) => {
  switch (suffix) {
    case "m":
    case "min":
      return n * 60
    case "h":
      return n * 3600
    case "d":
      return n * 86400
    default:
      // POSIX sleep (and GNU `sleep Ns`) counts seconds; "ms" is not a GNU
      // suffix and parses here as minutes-equivalent, which is fine for a
      // warning-only heuristic.
      return suffix === "s" || suffix === undefined ? n : n * 60
  }
}

export function detachWarnings(command: string): string[] {
  const warnings: string[] = []
  if (DETACH.test(command) || FOLLOW.test(command)) {
    warnings.push(
      `shell hygiene warning: this command looks like it backgrounds/detaches or follows a stream; it will be killed when the call ends. ${DURABLE_RUN_NOTE}`,
    )
  }
  SLEEP.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SLEEP.exec(command)) !== null) {
    if (sleepSeconds(Number(match[1]), match[2]) > 60) {
      warnings.push(
        `shell hygiene warning: sleep of >60s detected inside a tool call. Do not wait for future state inside a call — make one fast probe and check again next turn. ${DURABLE_RUN_NOTE}`,
      )
      break
    }
  }
  return warnings
}
