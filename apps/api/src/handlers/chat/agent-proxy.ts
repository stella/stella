import { Result } from "better-result"

import { createSafeRootHandler } from "@/api/lib/api-handlers"
import { HandlerError } from "@/api/lib/errors/tagged-errors"
import { getOrCreateSession } from "@/api/lib/opencode-session-manager"
import { transformOpencodeToStellaSSE } from "@/api/lib/sse-transformer"
import { env } from "@/api/env"

export const config = {
  permissions: { chat: ["create"] },
  body: {} as any,
  requiresUsage: { actionType: "chat" },
} as const

export default createSafeRootHandler(config, async function* (ctx) {
  if (env.USE_OPENCODE_CHAT !== "true") {
    const { default: sendMessage } = await import("./send-message")
    return await sendMessage.handler(ctx as any)
  }

  const body = ctx.body as { text?: string; threadId?: string; workspaceId?: string }
  const userMessage = body.text ?? ""
  const threadId = body.threadId ?? ""
  const workspaceId = body.workspaceId ?? null

  const session = yield* Result.await(
    getOrCreateSession(threadId, workspaceId, ctx.user.id),
  )

  const baseUrl = env.OPENCODE_BASE_URL ?? "http://opencode-auth:4096"
  const opencodeResponse = await fetch(
    `${baseUrl}/api/sessions/${session.sessionId}/prompt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.request.headers.get("authorization") ?? ""}`,
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: userMessage }],
        agent: "build",
      }),
    },
  )

  if (!opencodeResponse.ok) {
    throw new HandlerError({ status: 502, message: "Opencode request failed" })
  }

  const data = (await opencodeResponse.json()) as {
    info: { id: string; role: string }
    parts: unknown[]
  }

  const stream = {
    [Symbol.asyncIterator]() {
      let exhausted = false
      return {
        next: () => {
          if (exhausted) return Promise.resolve({ done: true, value: undefined as any })
          exhausted = true
          return Promise.resolve({ done: false, value: data })
        },
      }
    },
  }

  const thirdPartyBoundary = {} as any
  const sseStream = transformOpencodeToStellaSSE(stream, thirdPartyBoundary)

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async pull(controller) {
      for await (const chunk of sseStream) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
})
