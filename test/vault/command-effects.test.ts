import { Command } from "commander"
import { expect, it } from "vitest"
import { takeVaultMutation, vaultMutation } from "../../src/vault/command-effects.js"

it("tracks a newly named mutating command before it can partially fail", async () => {
  const program = new Command()
  program
    .command("new-operation")
    .hook("preAction", vaultMutation())
    .action(() => {
      throw new Error("partial failure")
    })
  await expect(program.parseAsync(["new-operation"], { from: "user" })).rejects.toThrow("partial")
  expect(takeVaultMutation(program)).toBe(true)
  expect(takeVaultMutation(program)).toBe(false)
})

it("declares conditional writes at the command and leaves previews read-only", async () => {
  const program = new Command()
  program
    .command("preview")
    .option("--apply")
    .hook(
      "preAction",
      vaultMutation((options) => Boolean(options.apply)),
    )
    .action(() => undefined)
  await program.parseAsync(["preview"], { from: "user" })
  expect(takeVaultMutation(program)).toBe(false)
  await program.parseAsync(["preview", "--apply"], { from: "user" })
  expect(takeVaultMutation(program)).toBe(true)
})

it("does not inherit a parent's write declaration for read-only subcommands", async () => {
  const program = new Command()
  const group = program
    .command("experiment")
    .hook("preAction", vaultMutation())
    .action(() => {})
  group.command("show").action(() => {})
  group
    .command("resume")
    .hook("preAction", vaultMutation())
    .action(() => {})
  await program.parseAsync(["experiment", "show"], { from: "user" })
  expect(takeVaultMutation(program)).toBe(false)
  await program.parseAsync(["experiment", "resume"], { from: "user" })
  expect(takeVaultMutation(program)).toBe(true)
})
