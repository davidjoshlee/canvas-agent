#!/usr/bin/env node
// Synthetic test wrapper only: delegate to real Git, then hold a partial
// fast-import stream after it creates a new pack file. No network or user home.
const assert = require("node:assert/strict")
const { spawn } = require("node:child_process")
const { readFileSync, readdirSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")
const control = JSON.parse(readFileSync(join(__dirname, "control.json"), "utf8"))
const args = process.argv.slice(2)
assert(args.includes(`--git-dir=${control.store}`))
assert(control.realGit !== __filename)
if (!args.includes("fast-import")) {
  const child = spawn(control.realGit, args, { stdio: "inherit", env: process.env })
  child.on("error", () => process.exit(90))
  child.on("close", (code) => process.exit(code ?? 91))
} else {
  const chunks = []
  let size = 0
  process.stdin.on("data", (bytes) => {
    size += bytes.length
    assert(size < 1024 * 1024, "Synthetic import exceeds test bound")
    chunks.push(bytes)
  })
  process.stdin.on("end", () => {
    const input = Buffer.concat(chunks)
    const native = spawn(control.realGit, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    })
    native.stdout.pipe(process.stdout)
    native.stderr.pipe(process.stderr)
    native.stdin.on("error", () => {})
    native.on("error", () => process.exit(92))
    native.on("close", (code) => process.exit(code ?? 93))
    native.once("spawn", () => {
      const partialBytes = Math.floor(input.length / 2)
      native.stdin.write(input.subarray(0, partialBytes))
      const started = Date.now()
      const timer = setInterval(() => {
        const newPackFiles = readdirSync(join(control.store, "objects/pack")).filter(
          (name) => !control.beforePackFiles.includes(name),
        )
        if (newPackFiles.length) {
          clearInterval(timer)
          writeFileSync(
            control.checkpoint,
            JSON.stringify({
              wrapperPid: process.pid,
              gitPid: native.pid,
              partialBytes,
              totalBytes: input.length,
              newPackFiles,
            }),
            { flag: "wx", mode: 0o600 },
          )
          // Keep native stdin open. The parent kills this exact detached group.
        } else if (Date.now() - started > 5000) {
          clearInterval(timer)
          native.kill("SIGKILL")
          process.exit(94)
        }
      }, 10)
    })
  })
}
