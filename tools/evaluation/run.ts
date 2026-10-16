#!/usr/bin/env node
import { runCli } from "../../src/cli/program.js"
import { registerEvaluationCommands } from "./commands.js"

await runCli(process.argv.slice(2), { registerCommands: registerEvaluationCommands })
