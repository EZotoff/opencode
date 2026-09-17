// Process-group enumeration + signaling-gate tests (contract addendum v2).
import { describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { ProcessGroup } from "@opencode-ai/core/process-group"

const posix = process.platform !== "win32" && ProcessGroup.supported

const killGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // already gone
  }
}

const gone = async (pid: number) => {
  const end = Date.now() + 2000
  while (Date.now() < end) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`pid ${pid} still exists`)
}

describe("process-group", () => {
  it("verifies leader identity at arm", async () => {
    if (!posix) return
    const proc = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
    try {
      const group = ProcessGroup.arm(proc.pid!)
      expect(group.armed).toBe(true)
      expect(ProcessGroup.leader(group)).toBe("alive")
    } finally {
      killGroup(proc.pid!)
      await gone(proc.pid!)
    }
  })

  it("refuses to arm a non-group-leader (identity-unverified)", async () => {
    if (!posix) return
    // not detached: the child stays in OUR process group, so pgrp !== pid
    const proc = spawn("bash", ["-c", "sleep 30"], { detached: false, stdio: "ignore" })
    try {
      const group = ProcessGroup.arm(proc.pid!)
      expect(group.armed).toBe(false)
      expect(ProcessGroup.signal(group, "SIGKILL").tag).toBe("unverified")
    } finally {
      proc.kill("SIGKILL")
      await gone(proc.pid!)
    }
  })

  it("enumeration distinguishes leader-only from leader-plus-child", async () => {
    if (!posix) return
    const solo = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
    const withChild = spawn("bash", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" })
    try {
      const g1 = ProcessGroup.arm(solo.pid!)
      const g2 = ProcessGroup.arm(withChild.pid!)
      // give the child a beat to fork
      const end = Date.now() + 2000
      let members: number[] | undefined
      while (Date.now() < end) {
        members = ProcessGroup.members(g2)
        if (members && members.length === 1) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(ProcessGroup.members(g1)).toEqual([])
      expect(members).toHaveLength(1)
      expect(members![0]).not.toBe(withChild.pid)
    } finally {
      killGroup(solo.pid!)
      killGroup(withChild.pid!)
      await gone(solo.pid!)
      await gone(withChild.pid!)
    }
  })

  it("gate signals a live group once, then disarms after it empties", async () => {
    if (!posix) return
    const proc = spawn("bash", ["-c", "sleep 30"], { detached: true, stdio: "ignore" })
    const group = ProcessGroup.arm(proc.pid!)
    try {
      expect(ProcessGroup.signal(group, "SIGKILL").tag).toBe("live-target")
      await gone(proc.pid!)
      // leader dead + empty enumeration -> ESRCH and permanent disarm
      expect(ProcessGroup.signal(group, "SIGKILL").tag).toBe("esrch")
      expect(ProcessGroup.signal(group, "SIGKILL").tag).toBe("disarmed")
    } finally {
      killGroup(proc.pid!)
    }
  })
})
