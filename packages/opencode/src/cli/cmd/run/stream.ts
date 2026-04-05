import type { FooterApi, FooterPatch } from "./types"
import type { SessionDataOutput } from "./session-data"

type Trace = {
  write(type: string, data?: unknown): void
}

type OutputInput = {
  footer: FooterApi
  trace?: Trace
}

function patch(next: FooterPatch): FooterPatch {
  if (typeof next.status === "string" && next.phase === undefined) {
    return {
      phase: "running",
      ...next,
    }
  }

  return next
}

export function writeSessionOutput(input: OutputInput, out: SessionDataOutput): void {
  for (const commit of out.commits) {
    input.trace?.write("ui.commit", commit)
    input.footer.append(commit)
  }

  if (out.footer?.patch) {
    const next = patch(out.footer.patch)
    input.trace?.write("ui.patch", next)
    input.footer.event({
      type: "stream.patch",
      patch: next,
    })
  }

  if (!out.footer?.view) {
    return
  }

  input.trace?.write("ui.patch", {
    view: out.footer.view,
  })
  input.footer.event({
    type: "stream.view",
    view: out.footer.view,
  })
}
