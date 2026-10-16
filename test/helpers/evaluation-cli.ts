import { createRequire } from "node:module"
import { resolve } from "node:path"

/** Keep ordinary commands on the compiled CLI; experiments require the checkout runner. */
export function evaluationCliArgs(args: string[]): string[] {
  const development =
    args[0] === "dogfood" ||
    (args[0] === "simulate" && ["window", "compare"].includes(args[1] ?? "")) ||
    (args[0] === "gate" && args[1] === "m1")
  return development
    ? [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        resolve("tools/evaluation/run.ts"),
        ...args,
      ]
    : [resolve("dist/cli.js"), ...args]
}
