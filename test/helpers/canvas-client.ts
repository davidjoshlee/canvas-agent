import {
  type CanvasAddressResolver,
  type CanvasClient,
  type CanvasClientOptions,
  type CanvasFetch,
  type CanvasSleep,
  createCanvasClient,
} from "../../src/canvas/client.js"
import type { ToolkitConfig } from "../../src/shared/types.js"

/** Local test scope for synthetic Canvas behavior; no production globals are changed. */
export function createCanvasTestTransport() {
  let options: CanvasClientOptions = {}
  return {
    use(optionsForTest: CanvasClientOptions): void {
      options = { ...options, ...optionsForTest }
    },
    reset(): void {
      options = {}
    },
    client(config: ToolkitConfig): CanvasClient {
      return createCanvasClient(config, options)
    },
  }
}

export type { CanvasAddressResolver, CanvasFetch, CanvasSleep }
