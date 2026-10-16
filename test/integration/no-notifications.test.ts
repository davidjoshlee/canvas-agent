import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { loginAuth } from "../../src/auth/credentials.js"
import { createConfig, saveAllowlist } from "../../src/config/index.js"
import { planReadingCopy } from "../../src/vault/reading-copy.js"
import { inspectWorkspace } from "../../src/vault/workspace.js"

const roots: string[] = []
async function fixture(baseUrl = "https://canvas.example.test") {
  const root = await mkdtemp(join(tmpdir(), "canvas-no-notifications-"))
  roots.push(root)
  const path = join(root, "config.json")
  const config = await createConfig(path, {
    vault: "vault",
    baseUrl,
    tokenEnv: "CANVAS_NO_NOTIFICATION_TEST_TOKEN",
  })
  return { root, path, config }
}
afterEach(async () => {
  delete process.env.CANVAS_NO_NOTIFICATION_TEST_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("reports authentication failures and sync results without creating notifications or modifying legacy alert files", async () => {
  let authorized = false
  let html = false
  const server = createServer((request, response) => {
    if (
      request.method !== "GET" ||
      request.headers.authorization !== "Bearer synthetic-auth-token"
    ) {
      response.writeHead(401).end("PRIVATE_401_BODY")
      return
    }
    if (authorized && request.url?.startsWith("/api/v1/courses")) {
      const path = new URL(request.url, "http://localhost").pathname
      const course = { id: 1, course_code: "CS101", name: "Synthetic course" }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify(
            path === "/api/v1/courses" ? [course] : path === "/api/v1/courses/1" ? course : [],
          ),
        )
      return
    }
    response
      .writeHead(authorized ? 200 : 401, { "content-type": "application/json" })
      .end(
        authorized
          ? html
            ? "<html>PRIVATE_SIGN_IN_PAGE</html>"
            : JSON.stringify({ id: 1, name: "PRIVATE_PROFILE_NAME", email: "PRIVATE_EMAIL" })
          : "PRIVATE_401_BODY",
      )
  })
  try {
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Synthetic server address missing")
    const f = await fixture(`http://127.0.0.1:${address.port}`)
    process.env.CANVAS_NO_NOTIFICATION_TEST_TOKEN = "synthetic-auth-token"
    await loginAuth(f.path, f.config, {
      expiresAt: "2025-02-01T00:00:00Z",
      now: new Date("2025-01-01T00:00:00Z"),
    })
    const command = async (args: string[]) => {
      try {
        const value = await promisify(execFile)(
          process.execPath,
          [resolve("dist/cli.js"), ...args, "--config", f.path, "--json"],
          {
            env: { ...process.env, CANVAS_NO_NOTIFICATION_TEST_TOKEN: "synthetic-auth-token" },
            timeout: 15000,
          },
        )
        return { code: 0, ...value }
      } catch (error) {
        const value = error as { stdout: string; stderr: string; code: number }
        return { stdout: value.stdout, stderr: value.stderr, code: value.code }
      }
    }
    const denied = await command(["auth", "verify"])
    expect(denied.code).not.toBe(0)
    expect(JSON.parse(denied.stderr)).toEqual({ error: expect.stringContaining("auth renew") })
    await expect(stat(join(f.config.vault.path, "_meta/auth-alerts"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(stat(join(f.config.vault.path, "_meta/due-soon"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    const legacy = new Map([
      ["_meta/auth-alerts/legacy/ALERT.md", "STUDENT_EDITED_WARNING"],
      ["_meta/auth-alerts/legacy/.lock", "Retained old auth lock"],
      ["_meta/due-soon/ALERT.md", "Retained due-soon reminder"],
      ["_meta/due-soon/.lock", "Retained old due-soon lock"],
      ["_meta/due-soon/state.json", "Retained old state bytes"],
      ["_meta/due-soon/archive.json", "Retained old report bytes"],
    ])
    for (const [path, bytes] of legacy) {
      await mkdir(resolve(f.config.vault.path, path, ".."), { recursive: true, mode: 0o700 })
      await writeFile(join(f.config.vault.path, path), bytes, { mode: 0o600 })
    }
    authorized = true
    html = true
    expect((await command(["auth", "verify"])).code).not.toBe(0)
    html = false
    const verified = await command(["auth", "verify"])
    expect(verified.code, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true })
    expect(JSON.parse(verified.stdout)).not.toHaveProperty("alert")
    expect(JSON.parse((await command(["auth", "status"])).stdout).renewal).toBe("expired")
    await saveAllowlist(f.path, ["1"])
    authorized = false
    const failedSync = await command(["sync"])
    expect(failedSync.code).not.toBe(0)
    expect(JSON.parse(failedSync.stderr)).toEqual({ error: expect.stringContaining("auth renew") })
    authorized = true
    const synced = await command(["sync"])
    expect(synced.code, synced.stderr).toBe(0)
    expect(JSON.parse(synced.stdout)).toMatchObject({ courses: 1 })
    expect(JSON.parse(synced.stdout)).not.toHaveProperty("dueSoon")
    for (const [path, bytes] of legacy)
      expect(await readFile(join(f.config.vault.path, path), "utf8")).toBe(bytes)
    expect(await readdir(join(f.config.vault.path, "_meta/auth-alerts"))).toEqual(["legacy"])
    expect((await readdir(join(f.config.vault.path, "_meta/due-soon"))).sort()).toEqual([
      ".lock",
      "ALERT.md",
      "archive.json",
      "state.json",
    ])
    expect(JSON.stringify(await inspectWorkspace(f.config.vault.path))).not.toContain(
      "auth-alerts/",
    )
    expect(
      JSON.stringify(await planReadingCopy(f.config.vault.path, join(f.root, "phone"))),
    ).not.toMatch(/auth-alerts|due-soon/)
    expect(denied.stderr + verified.stdout + synced.stdout + failedSync.stderr).not.toMatch(
      /synthetic-auth-token|PRIVATE_/,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
}, 30000)
