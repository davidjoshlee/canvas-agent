import { afterEach, describe, expect, it } from "vitest"
import { createCanvasClient } from "../../src/canvas/client.js"
import type { ToolkitConfig } from "../../src/shared/types.js"

const config = (baseUrl: string, tokenEnv: string): ToolkitConfig => ({
  version: 1,
  canvas: { baseUrl, tokenEnv },
  vault: { path: "/synthetic/vault" },
  courses: { allowlist: ["1"] },
})

afterEach(() => {
  delete process.env.CANVAS_CLIENT_FIRST_TOKEN
  delete process.env.CANVAS_CLIENT_SECOND_TOKEN
})

describe("instance-scoped Canvas transport", () => {
  it("keeps fetch and credentials isolated between clients used concurrently", async () => {
    process.env.CANVAS_CLIENT_FIRST_TOKEN = "synthetic-first-token"
    process.env.CANVAS_CLIENT_SECOND_TOKEN = "synthetic-second-token"
    const firstCalls: string[] = []
    const secondCalls: string[] = []
    const first = createCanvasClient(
      config("https://first.example.test", "CANVAS_CLIENT_FIRST_TOKEN"),
      {
        fetch: async (input, init) => {
          expect(init?.method).toBe("GET")
          firstCalls.push(
            `${new URL(String(input)).origin}:${new Headers(init?.headers).get("authorization")}`,
          )
          return new Response("first")
        },
        sleep: async () => undefined,
      },
    )
    const second = createCanvasClient(
      config("https://second.example.test", "CANVAS_CLIENT_SECOND_TOKEN"),
      {
        fetch: async (input, init) => {
          expect(init?.method).toBe("GET")
          secondCalls.push(
            `${new URL(String(input)).origin}:${new Headers(init?.headers).get("authorization")}`,
          )
          return new Response("second")
        },
        sleep: async () => undefined,
      },
    )

    const [firstResponse, secondResponse] = await Promise.all([
      first.get(new URL("https://first.example.test/api/v1/users/self")),
      second.get(new URL("https://second.example.test/api/v1/users/self")),
    ])

    expect(await firstResponse.text()).toBe("first")
    expect(await secondResponse.text()).toBe("second")
    expect(firstCalls).toEqual(["https://first.example.test:Bearer synthetic-first-token"])
    expect(secondCalls).toEqual(["https://second.example.test:Bearer synthetic-second-token"])
  })

  it("keeps same-origin checks and DNS validation attached to their client", async () => {
    let fetched = 0
    const first = createCanvasClient(
      config("https://first.example.test", "CANVAS_CLIENT_FIRST_TOKEN"),
      {
        fetch: async () => {
          fetched++
          return new Response("ok")
        },
        resolveAddresses: async () => ["10.0.0.7"],
      },
    )
    const second = createCanvasClient(
      config("https://second.example.test", "CANVAS_CLIENT_SECOND_TOKEN"),
      {
        fetch: async () => {
          fetched++
          return new Response("ok")
        },
        resolveAddresses: async () => ["8.8.8.8"],
      },
    )

    await expect(first.get(new URL("https://second.example.test/api/v1/courses"))).rejects.toThrow(
      /outside the safe configured origin/,
    )
    expect(await first.publicHttpsUrl("https://files.example.test/item")).toBeUndefined()
    expect(await second.publicHttpsUrl("https://files.example.test/item")).toEqual(
      new URL("https://files.example.test/item"),
    )
    expect(fetched).toBe(0)
  })
})
