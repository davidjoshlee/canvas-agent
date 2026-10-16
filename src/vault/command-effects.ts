import type { Command } from "commander"

const pending = new WeakSet<Command>()

/** Declare a command's vault writes alongside its registration, before its action runs. */
export function vaultMutation(when: (options: Record<string, unknown>) => boolean = () => true) {
  return (_command: Command, action: Command): void => {
    if (_command !== action || !when(action.opts())) return
    let root = action
    while (root.parent) root = root.parent
    pending.add(root)
  }
}

/** Consume once on success or failure; history must never change the primary result. */
export function takeVaultMutation(program: Command): boolean {
  const changed = pending.has(program)
  pending.delete(program)
  return changed
}
