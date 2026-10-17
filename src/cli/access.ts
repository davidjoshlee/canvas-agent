import type { Command } from "commander"
import {
  authStatus,
  importSchoolKeychainAuth,
  loginAuth,
  renewalInstructions,
} from "../auth/credentials.js"
import { type CanvasClientFactory, createCanvasClient } from "../canvas/client.js"
import { verifyAuth } from "../canvas/sync.js"
import { loadAdjacentEnv, loadConfig } from "../config/index.js"
import type { ToolkitConfig } from "../shared/types.js"
import { doctorChecks } from "./health.js"
import { configWithEnv, render } from "./output.js"

export function registerAccessCommands(
  program: Command,
  canvasClient: CanvasClientFactory = createCanvasClient,
): void {
  registerDoctorCommand(program)
  const auth = program.command("auth").description("provision, check, and renew Canvas credentials")
  registerCredentialProvisioning(program, auth)
  registerCredentialRenewal(program, auth)
  registerCredentialVerification(program, auth, canvasClient)
}

function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("check local readiness without contacting Canvas")
    .option("--json", "emit JSON")
    .option("--sync-only", "check only sync prerequisites")
    .option("--offline", "report local readiness when Canvas access is not configured")
    .action(async (options) => {
      const configPath = program.opts().config as string
      await loadAdjacentEnv(configPath)
      let config: ToolkitConfig | undefined
      try {
        config = await loadConfig(configPath)
      } catch {
        /* summarized by doctorChecks */
      }
      if (options.offline && options.syncOnly)
        throw new Error("Choose --offline or --sync-only, not both")
      const result = await doctorChecks(configPath, config, {
        syncOnly: options.syncOnly,
        offline: options.offline,
      })
      render(
        result,
        options.json,
        result.checks.map((c) => `${c.status.toUpperCase()} ${c.name}: ${c.message}`).join("\n"),
      )
      if (!result.ok) process.exitCode = 1
    })
}

function registerCredentialProvisioning(program: Command, auth: Command): void {
  auth
    .command("login")
    .description(
      "save a locally provisioned token in private adjacent .env and record confirmed expiry",
    )
    .requiredOption("--expires-at <iso>", "confirmed token expiry from Canvas")
    .option("--account <name>", "local account label (not a credential)", "local")
    .option("--replace", "explicitly replace a previously saved token")
    .option("--json", "emit credential-free JSON")
    .action(async (options) => {
      const path = program.opts().config
      const config = await configWithEnv(path)
      const result = await loginAuth(path, config, {
        expiresAt: options.expiresAt,
        account: options.account,
        replace: options.replace,
      })
      render(
        result,
        options.json,
        `Canvas token stored in private adjacent .env; confirmed expiry recorded: ${result.expiresAt}. Run auth verify to check API authorization.`,
      )
    })
  auth
    .command("import-school-keychain")
    .description(
      "opt in to import one named School macOS Keychain token into private dotenv storage",
    )
    .requiredOption("--account <name>", "exact account used by School auth login")
    .requiredOption("--expires-at <iso>", "confirmed future token expiry from Canvas")
    .option("--replace", "explicitly replace a previously saved dotenv token")
    .option("--json", "emit credential-free import metadata")
    .action(async (options) => {
      const path = program.opts().config
      const config = await loadConfig(path)
      const result = await importSchoolKeychainAuth(path, config, options)
      render(
        result,
        options.json,
        `Selected School token imported into private adjacent .env; Keychain unchanged.\n${result.nextSteps}`,
      )
    })
}

function registerCredentialRenewal(program: Command, auth: Command): void {
  auth
    .command("renew")
    .description("show manual Canvas token renewal steps; no network or automatic token minting")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await loadConfig(program.opts().config)
      const result = renewalInstructions(config)
      render(
        result,
        options.json,
        [result.settingsUrl, ...result.steps.map((step, index) => `${index + 1}. ${step}`)].join(
          "\n",
        ),
      )
    })
}

function registerCredentialVerification(
  program: Command,
  auth: Command,
  canvasClient: CanvasClientFactory,
): void {
  auth
    .command("verify")
    .description("verify configured credentials with a read-only request")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await verifyAuth(config, canvasClient(config))
      render(result, options.json, "Canvas authentication succeeded.")
    })
  auth
    .command("status")
    .description("report local token presence and recorded expiry; not API authorization")
    .option("--json", "emit JSON")
    .action(async (options) => {
      const config = await configWithEnv(program.opts().config)
      const result = await authStatus(program.opts().config, config)
      render(
        result,
        options.json,
        `Configured Canvas token environment variable ${config.canvas.tokenEnv} is ${result.available ? "available locally" : "not set"}.\nRecorded renewal state: ${result.renewal}.${"expiresAt" in result ? ` Expiry: ${result.expiresAt}.` : ""} This does not verify API authorization.`,
      )
    })
}
