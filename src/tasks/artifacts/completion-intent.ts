import { publishExclusiveFile, readBoundedFile, vaultPath } from "../../shared/fs-safety.js"

export type CompletionIntent = { version: 1; kind: "file" | "bundle"; hash: string }

export async function claimCompletionIntent(vault: string, id: string, intent: CompletionIntent) {
  const path = await vaultPath(vault, `_meta/tasks/${id}/completion.intent.json`, true)
  const bytes = Buffer.from(`${JSON.stringify(intent)}\n`)
  try {
    await publishExclusiveFile(path, bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const stored = await readBoundedFile(path, 4096)
    if (!stored.equals(bytes))
      throw new Error("A different completion is already claimed for this task")
  }
}
