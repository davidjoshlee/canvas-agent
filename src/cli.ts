#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runCli } from "./cli/program.js"

export { runCli }

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  await runCli()
}
