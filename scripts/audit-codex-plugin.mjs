import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"

// Native discovery and mock-provider context capture. No credentials, real model
// calls, real settings/cache,
// student vaults, remote marketplace sources, or coursework are used.
const checkout = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), "canvas-codex-plugin-"))
const taskCodexHome = join(root, "codex-home")
const taskOsHome = join(root, "os-home")
const marketplace = join(root, "marketplace")
const workspace = join(root, "unrelated-workspace")
for (const path of [taskCodexHome, taskOsHome, workspace, join(marketplace, ".agents/plugins")])
  await mkdir(path, { recursive: true })
await cp(join(checkout, "plugins/canvas-agent"), join(marketplace, "plugins/canvas-agent"), {
  recursive: true,
  errorOnExist: true,
  force: false,
})
await cp(
  join(checkout, ".agents/plugins/marketplace.json"),
  join(marketplace, ".agents/plugins/marketplace.json"),
  { errorOnExist: true, force: false },
)
const env = Object.fromEntries(
  ["PATH", "SystemRoot", "COMSPEC", "PATHEXT"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
)
// These are child-only platform configuration paths, not repurposed shell vars.
Object.assign(env, {
  CODEX_HOME: taskCodexHome,
  HOME: taskOsHome,
  TMPDIR: root,
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "localhost,127.0.0.1",
})
const executable = process.argv[2] ?? "codex"
function command(args) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = "",
      size = 0
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Native plugin command timed out"))
    }, 30_000)
    const append = (target, bytes) => {
      size += bytes.length
      if (size > 2_000_000) {
        child.kill("SIGKILL")
        reject(new Error("Native plugin output exceeds bounds"))
        return
      }
      if (target === "stdout") stdout += bytes
      else stderr += bytes
    }
    child.stdout.on("data", (bytes) => append("stdout", bytes))
    child.stderr.on("data", (bytes) => append("stderr", bytes))
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Native plugin command failed: ${stderr.slice(0, 2000)}`))
      else resolveCommand(stdout)
    })
  })
}
const version = (await command(["--version"])).trim()
const added = JSON.parse(await command(["plugin", "marketplace", "add", marketplace, "--json"]))
const installed = JSON.parse(
  await command(["plugin", "add", "canvas-agent@canvas-agent-tools", "--json"]),
)
const listed = JSON.parse(
  await command(["plugin", "list", "--marketplace", "canvas-agent-tools", "--json"]),
)
await writeFile(
  join(root, "installation.json"),
  JSON.stringify({ version, added, installed, listed }, null, 2),
  { flag: "wx" },
)

const captures = [],
  providerErrors = []
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/v1/responses")
    assert.equal(request.headers.authorization, undefined)
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert(size <= 2_000_000, "Mock context request exceeds bounds")
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    captures.push(body)
    const number = captures.length
    await writeFile(join(root, `request-${number}.json`), JSON.stringify(body, null, 2), {
      flag: "wx",
    })
    const id = `resp_context_${number}`
    const text = "Synthetic context probe complete."
    const part = { type: "output_text", text, annotations: [] }
    const item = {
      id: `msg_context_${number}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [part],
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    let sequence = 0
    const emit = (type, fields) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`,
      )
    emit("response.created", {
      response: { id, object: "response", status: "in_progress", output: [] },
    })
    emit("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    })
    emit("response.content_part.added", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "" },
    })
    emit("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    })
    emit("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text })
    emit("response.content_part.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part,
    })
    emit("response.output_item.done", { output_index: 0, item })
    emit("response.completed", {
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })
    response.end()
  } catch (error) {
    providerErrors.push(error.message)
    response.writeHead(500)
    response.end("Invalid synthetic context probe")
  }
})
await new Promise((resolveListen, reject) => {
  provider.once("error", reject)
  provider.listen(0, "127.0.0.1", resolveListen)
})
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`
const child = spawn(
  executable,
  [
    "app-server",
    "--listen",
    "stdio://",
    "-c",
    'model_provider="context_fixture"',
    "-c",
    'model="context-fixture"',
    "-c",
    'model_providers.context_fixture.name="Local context fixture"',
    "-c",
    `model_providers.context_fixture.base_url=${JSON.stringify(providerUrl)}`,
    "-c",
    'model_providers.context_fixture.wire_api="responses"',
    "-c",
    "model_providers.context_fixture.requires_openai_auth=false",
    "-c",
    "model_providers.context_fixture.supports_websockets=false",
    "-c",
    "model_providers.context_fixture.request_max_retries=0",
    "-c",
    "model_providers.context_fixture.stream_max_retries=0",
    "-c",
    "model_providers.context_fixture.stream_idle_timeout_ms=5000",
    ...(process.argv.includes("--known-context") ? ["-c", "model_context_window=200000"] : []),
  ],
  {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  },
)
const lines = createInterface({ input: child.stdout })
const pending = new Map()
const turns = new Map()
let serial = 0,
  total = 0,
  stderr = ""
function abort(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer)
    request.reject(error)
  }
  pending.clear()
  for (const turn of turns.values()) {
    clearTimeout(turn.timer)
    turn.reject(error)
  }
  turns.clear()
}
child.stderr.on("data", (bytes) => {
  total += bytes.length
  stderr += bytes
  if (total > 2_000_000) {
    abort(new Error("Native discovery output exceeds bounds"))
    child.kill("SIGKILL")
  }
})
child.once("error", abort)
child.once("exit", () =>
  abort(new Error(`Native discovery server exited: ${stderr.slice(0, 1000)}`)),
)
lines.on("line", (line) => {
  total += Buffer.byteLength(line)
  if (total > 2_000_000) {
    abort(new Error("Native discovery output exceeds bounds"))
    child.kill("SIGKILL")
    return
  }
  let response
  try {
    response = JSON.parse(line)
  } catch {
    abort(new Error("Native discovery returned invalid JSON"))
    return
  }
  const request = pending.get(response.id)
  if (response.method === "turn/completed") {
    const turn = turns.get(response.params.threadId)
    if (turn) {
      turns.delete(response.params.threadId)
      clearTimeout(turn.timer)
      turn.resolve(response.params.turn)
    }
  }
  if (!request) return
  pending.delete(response.id)
  clearTimeout(request.timer)
  if (response.error)
    request.reject(
      new Error(`Native discovery rejected request: ${JSON.stringify(response.error)}`),
    )
  else request.resolve(response.result)
})
function rpc(method, params) {
  return new Promise((resolveRequest, reject) => {
    const id = ++serial
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Native discovery timed out: ${method}`))
    }, 15_000)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}
async function probe(cwd, skill) {
  const started = await rpc("thread/start", {
    cwd,
    model: "context-fixture",
    modelProvider: "context_fixture",
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  })
  const id = started.thread.id
  const previous = captures.length
  const completed = new Promise((resolveTurn, reject) => {
    const timer = setTimeout(() => {
      turns.delete(id)
      reject(new Error("Synthetic context turn timed out"))
    }, 15_000)
    turns.set(id, { resolve: resolveTurn, reject, timer })
  })
  const input = [
    {
      type: "text",
      text: `${skill ? `$${skill.name} ` : ""}Synthetic context probe only. Do not read files or run tools; return a short acknowledgement.`,
    },
  ]
  if (skill) input.push({ type: "skill", name: skill.name, path: skill.path })
  const [, turn] = await Promise.all([rpc("turn/start", { threadId: id, input }), completed])
  assert.equal(turn.status, "completed", JSON.stringify(turn.error))
  assert.deepEqual(providerErrors, [])
  assert.equal(captures.length, previous + 1)
  assert(
    !turn.items.some((item) =>
      ["commandExecution", "fileChange", "mcpToolCall"].includes(item.type),
    ),
  )
  return captures[previous]
}
function strings(value) {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}
function core(text) {
  const block = text.match(/<!-- canvas-agent-cli:start -->[\s\S]*?<!-- canvas-agent-cli:end -->/)
  assert(block, "Source lacks shared core")
  return block[0]
}
try {
  await rpc("initialize", {
    clientInfo: {
      name: "canvas_agent_plugin_audit",
      title: "Canvas Agent synthetic plugin audit",
      version: "0.4.0",
    },
    capabilities: { experimentalApi: true },
  })
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`)
  const catalog = await rpc("skills/list", { cwds: [workspace], forceReload: true })
  await writeFile(join(root, "skills.json"), JSON.stringify(catalog, null, 2), { flag: "wx" })
  const row = catalog.data.find((entry) => entry.cwd === workspace)
  assert(row, "Native catalog omitted unrelated workspace")
  assert.deepEqual(row.errors, [])
  const skills = row.skills.filter((skill) => skill.path.includes("/canvas-agent/"))
  const cacheRoot = await realpath(join(taskCodexHome, "plugins/cache"))
  const expected = ["assignment-workflow", "canvas-workspace", "setup-and-sync"]
  assert.equal(skills.length, 3, "Fresh native runtime must discover all three installed skills")
  for (const name of expected) {
    const skill = skills.find((entry) => entry.path.endsWith(`/skills/${name}/SKILL.md`))
    assert(skill, `Native runtime omitted ${name}`)
    assert.equal(skill.enabled, true)
    assert(
      (await realpath(skill.path)).startsWith(`${cacheRoot}/`),
      "Runtime must use fresh installed cache, not source paths",
    )
    assert.deepEqual(
      await readFile(skill.path),
      await readFile(join(checkout, "plugins/canvas-agent/skills", name, "SKILL.md")),
    )
    const pluginRoot = dirname(dirname(dirname(skill.path)))
    assert.deepEqual(
      await readFile(join(pluginRoot, "references/cli.md")),
      await readFile(join(checkout, "plugins/canvas-agent/references/cli.md")),
    )
    assert.deepEqual(
      await readFile(join(pluginRoot, "references/workflows.md")),
      await readFile(join(checkout, "plugins/canvas-agent/references/workflows.md")),
    )
  }
  const injected = []
  for (const skill of skills) {
    const request = await probe(workspace, skill)
    const text = strings(request.input).join("\n")
    const sourceText = await readFile(skill.path, "utf8")
    assert(text.includes(core(sourceText)), `Native turn omitted/truncated core for ${skill.name}`)
    assert(
      text.includes(sourceText.trimEnd()),
      `Native turn omitted complete skill body for ${skill.name}`,
    )
    for (const block of sourceText.matchAll(
      /<!-- canvas-agent-workflow:[\s\S]*?<!-- canvas-agent-workflow:[^>]+:end -->/g,
    ))
      assert(text.includes(block[0]), `Native turn omitted workflow for ${skill.name}`)
    injected.push(skill.name)
  }
  const project = join(root, "project-with-agents")
  await mkdir(project)
  await cp(join(checkout, "AGENTS.md"), join(project, "AGENTS.md"), {
    errorOnExist: true,
    force: false,
  })
  const projectText = strings((await probe(project)).input).join("\n")
  const agents = await readFile(join(project, "AGENTS.md"), "utf8")
  assert(projectText.includes(core(agents)), "Native project turn omitted/truncated AGENTS core")
  assert(projectText.includes(agents.trimEnd()), "Native project turn omitted complete AGENTS body")
  for (const block of agents.matchAll(
    /<!-- canvas-agent-workflow:[\s\S]*?<!-- canvas-agent-workflow:[^>]+:end -->/g,
  ))
    assert(projectText.includes(block[0]), "Native project turn omitted academic workflow")
  const assignmentSkill = skills.find((skill) =>
    skill.path.endsWith("/skills/assignment-workflow/SKILL.md"),
  )
  assert(assignmentSkill)
  const combinedText = strings((await probe(project, assignmentSkill)).input).join("\n")
  const assignmentBody = await readFile(assignmentSkill.path, "utf8")
  assert(
    combinedText.includes(agents.trimEnd()),
    "Combined native turn omitted/truncated project AGENTS",
  )
  assert(
    combinedText.includes(assignmentBody.trimEnd()),
    "Combined native turn omitted/truncated installed assignment skill",
  )
  console.log(
    JSON.stringify(
      {
        status: "pass",
        version,
        syntheticRoot: root,
        nativeFreshInstallTested: true,
        nativeSkillCatalogTested: true,
        unrelatedWorkspace: true,
        installedInstructionsMatch: true,
        realModelTurnTested: false,
        mockProviderTurns: captures.length,
        fullSkillInjectionTested: true,
        projectAgentsInjectionTested: true,
        combinedProjectSkillInjectionTested: true,
        injectedSkills: injected,
        goalControllerInterruptionTested: false,
        realSettingsOrCacheWritesPerformed: false,
        skills: await Promise.all(
          skills.map(async ({ name, path, enabled, scope }) => ({
            name,
            path,
            enabled,
            scope,
            hash: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          })),
        ),
      },
      null,
      2,
    ),
  )
} catch (error) {
  throw new Error(`${error.message}; synthetic evidence: ${root}`)
} finally {
  lines.close()
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
    child.kill("SIGTERM")
    const fallback = setTimeout(() => child.kill("SIGKILL"), 1000)
    await exited
    clearTimeout(fallback)
  }
  provider.closeAllConnections()
  await new Promise((resolveClose) => provider.close(resolveClose))
}
