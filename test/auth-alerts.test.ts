import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it } from "vitest"
import { loginAuth } from "../src/auth.js"
import { readAuthAlert, writeAuthAlert } from "../src/auth-alerts.js"
import { createConfig, saveAllowlist } from "../src/config.js"
import { planReadingCopy } from "../src/reading-copy.js"
import { inspectWorkspace } from "../src/workspace.js"

const roots: string[] = []
async function fixture(baseUrl = "https://canvas.example.test") {
  const root = await mkdtemp(join(tmpdir(), "canvas-auth-alerts-"))
  roots.push(root)
  const path = join(root, "config.json")
  const config = await createConfig(path, {
    vault: "vault",
    baseUrl,
    tokenEnv: "CANVAS_SYNTHETIC_AUTH_ALERT_TOKEN",
  })
  return { root, path, config }
}
afterEach(async () => {
  delete process.env.CANVAS_SYNTHETIC_AUTH_ALERT_TOKEN
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it("retains private scoped 401/resolution history without credentials and isolates other configs and origins", async () => {
  const f = await fixture(),
    now = new Date("2026-10-13T18:00:00Z")
  const warning = await writeAuthAlert(f.path, f.config, "http-401", { now })
  if (!("alertFile" in warning)) throw new Error("Synthetic alert missing")
  const directory = join(f.config.vault.path, warning.alertFile, "..")
  const archive = join(directory, `${warning.reportHash}.json`),
    bytes = await readFile(archive)
  expect(warning).toMatchObject({
    status: "reauthentication-required",
    currentAuthorizationVerified: false,
  })
  expect((await stat(join(f.config.vault.path, warning.alertFile))).mode & 0o777).toBe(0o600)
  const resolved = await writeAuthAlert(f.path, f.config, "api-verified", { now })
  expect(resolved).toMatchObject({ status: "resolved", reason: "api-verified" })
  expect(await readFile(archive)).toEqual(bytes)
  expect(await readAuthAlert(join(f.root, "another-config.json"), f.config)).toEqual({
    status: "no-record",
  })
  expect(
    await readAuthAlert(f.path, {
      ...f.config,
      canvas: { ...f.config.canvas, baseUrl: "https://other.example.test" },
    }),
  ).toEqual({ status: "no-record" })
  expect(JSON.stringify(await inspectWorkspace(f.config.vault.path))).not.toContain("auth-alerts/")
  expect(
    JSON.stringify(await planReadingCopy(f.config.vault.path, join(f.root, "phone"))),
  ).not.toContain("auth-alerts/")
  expect(bytes.toString()).not.toMatch(/tokenHash|profile|email|account|tokenEnv/)
})

it("does not create success-only alerts or overwrite edited warning files when resolving or recording another failure", async () => {
  const f = await fixture()
  expect(await writeAuthAlert(f.path, f.config, "api-verified")).toEqual({ status: "no-record" })
  await expect(stat(f.config.vault.path)).rejects.toThrow()
  const warning = await writeAuthAlert(f.path, f.config, "http-401")
  if (!("alertFile" in warning)) throw new Error("Synthetic alert missing")
  const path = join(f.config.vault.path, warning.alertFile)
  await writeFile(path, "STUDENT_EDITED_WARNING")
  await expect(writeAuthAlert(f.path, f.config, "api-verified")).rejects.toThrow(/changed/)
  await expect(writeAuthAlert(f.path, f.config, "http-401")).rejects.toThrow(/changed/)
  expect(await readFile(path, "utf8")).toBe("STUDENT_EDITED_WARNING")
})

it("labels local expiry as a hint and resolves it from successful API/resource evidence without claiming user identity", async () => {
  const f = await fixture(),
    now = new Date("2026-10-13T18:00:00Z")
  const warning = await writeAuthAlert(f.path, f.config, "recorded-expiry", {
    now,
    expiresAt: "2026-01-01T00:00:00Z",
  })
  expect(warning).toMatchObject({
    status: "local-expiry-warning",
    currentAuthorizationVerified: false,
  })
  await expect(
    writeAuthAlert(f.path, f.config, "recorded-expiry", { now, expiresAt: "2027-01-01T00:00:00Z" }),
  ).rejects.toThrow(/invalid/)
  expect(await writeAuthAlert(f.path, f.config, "selected-sync-succeeded", { now })).toMatchObject({
    status: "resolved",
    reason: "selected-sync-succeeded",
    currentAuthorizationVerified: false,
  })
})

it("records a compiled CLI 401, then accepts a valid profile despite expired local metadata and resolves the warning without leaking responses", async () => {
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
    process.env.CANVAS_SYNTHETIC_AUTH_ALERT_TOKEN = "synthetic-auth-token"
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
            env: { ...process.env, CANVAS_SYNTHETIC_AUTH_ALERT_TOKEN: "synthetic-auth-token" },
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
    expect(JSON.parse(denied.stderr).authAlert).toMatchObject({
      status: "reauthentication-required",
    })
    const cached = await command(["auth", "alerts"])
    expect(cached.code).toBe(0)
    expect(JSON.parse(cached.stdout).alert.status).toBe("reauthentication-required")
    authorized = true
    html = true
    const before = await readAuthAlert(f.path, f.config)
    expect((await command(["auth", "verify"])).code).not.toBe(0)
    expect(await readAuthAlert(f.path, f.config)).toEqual(before)
    html = false
    const verified = await command(["auth", "verify"])
    expect(verified.code, verified.stderr).toBe(0)
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      alert: { status: "resolved", reason: "api-verified" },
    })
    expect(JSON.parse((await command(["auth", "status"])).stdout).renewal).toBe("expired")
    const localHint = await command(["auth", "alerts", "--apply"])
    expect(localHint.code, localHint.stderr).toBe(0)
    expect(JSON.parse(localHint.stdout).alert.status).toBe("local-expiry-warning")
    await saveAllowlist(f.path, ["1"])
    authorized = false
    const failedSync = await command(["sync"])
    expect(failedSync.code).not.toBe(0)
    expect(JSON.parse(failedSync.stderr).authAlert.status).toBe("reauthentication-required")
    authorized = true
    const synced = await command(["sync"])
    expect(synced.code, synced.stderr).toBe(0)
    const syncResolution = await readAuthAlert(f.path, f.config)
    expect(syncResolution).toMatchObject({
      status: "resolved",
      reason: "selected-sync-succeeded",
      currentAuthorizationVerified: false,
    })
    if (!("alertFile" in syncResolution)) throw new Error("Synthetic resolution note missing")
    const edited = join(f.config.vault.path, syncResolution.alertFile)
    await writeFile(edited, "STUDENT_EDITED_WARNING")
    const unchangedSuccess = await command(["auth", "verify"])
    expect(unchangedSuccess.code, unchangedSuccess.stderr).toBe(0)
    expect(JSON.parse(unchangedSuccess.stdout)).toMatchObject({
      ok: true,
      alert: { status: "not-updated" },
    })
    expect(await readFile(edited, "utf8")).toBe("STUDENT_EDITED_WARNING")
    expect(denied.stderr + cached.stdout + verified.stdout + localHint.stdout).not.toMatch(
      /synthetic-auth-token|PRIVATE_/,
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
}, 30000)
