import { describe, expect, test } from "bun:test"

import { transformOpencodeToStellaSSE } from "./sse-transformer"

describe("transformOpencodeToStellaSSE", () => {
  test("converts text part to text-delta chunk", async () => {
    const stream = async function* (): AsyncGenerator<{
      info: { id: string; role: string }
      parts: Array<{ type: "text"; text: string; id?: string }>
    }> {
      yield { info: { id: "msg-1", role: "assistant" }, parts: [{ type: "text", text: "Hello world" }] }
    }

    const chunks: unknown[] = []
    for await (const chunk of transformOpencodeToStellaSSE(stream(), {} as any)) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: "text-delta", id: "msg-1", delta: "Hello world" })
  })
})
