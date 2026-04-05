import fs from "fs"
import path from "path"
import { Global } from "../../../global"

export type Trace = {
  write(type: string, data?: unknown): void
}

let state: Trace | false | undefined

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
}

function file() {
  return path.join(Global.Path.log, "direct", `${stamp()}-${process.pid}.jsonl`)
}

function latest() {
  return path.join(Global.Path.log, "direct", "latest.json")
}

function text(data: unknown) {
  return JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === "bigint") {
        return String(value)
      }

      return value
    },
    0,
  )
}

export function trace() {
  if (state !== undefined) {
    return state || undefined
  }

  if (!process.env.OPENCODE_DIRECT_TRACE) {
    state = false
    return
  }

  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    latest(),
    text({
      time: new Date().toISOString(),
      pid: process.pid,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
      path: target,
    }) + "\n",
  )
  state = {
    write(type: string, data?: unknown) {
      fs.appendFileSync(
        target,
        text({
          time: new Date().toISOString(),
          pid: process.pid,
          type,
          data,
        }) + "\n",
      )
    },
  }
  state.write("trace.start", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    path: target,
  })
  return state
}
