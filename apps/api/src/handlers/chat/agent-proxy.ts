import { Result } from "better-result"

import { createSafeRootHandler } from "@/api/lib/api-handlers"
import type { HandlerConfig } from "@/api/lib/api-handlers"
import { HandlerError } from "@/api/lib/errors/tagged-errors"
import { getOrCreateSession } from "@/api/lib/opencode-session-manager"
import { transformOpencodeToStellaSSE } from "@/api/lib/sse-transformer"
import { env } from "@/api/env"
import { CHAT_SEND_MODE, isChatSendMode } from "@stll/anonymize-chat"

export const config = {
  permissions: { agentSkill: ["create"] },
  body: {} as any,
  requiresUsage: { actionType: "chat" },
} satisfies HandlerConfig

type ChatBody = {
  text?: string
  threadId?: string
  workspaceId?: string
  sendMode?: string
}

const selectAgent = (sendMode: string | undefined): string => {
  if (sendMode === CHAT_SEND_MODE.anonymized) return "build-anonymized"
  return "build"
}

const handler = async function* (ctx: any) {
  if (!env.USE_OPENCODE_CHAT) {
    const { default: sendMessage } = await import("./send-message")
    return Result.ok(await sendMessage.handler(ctx as any))
  }

  const body = ctx.body as ChatBody
  const userMessage = body.text ?? ""
  const threadId = body.threadId ?? ""
  const workspaceId = body.workspaceId ?? null
  const sendMode = isChatSendMode(body.sendMode) ? body.sendMode : CHAT_SEND_MODE.rawOverride

  const sessionResult = await getOrCreateSession(threadId, workspaceId, ctx.user.id)
  if (Result.isError(sessionResult)) {
    throw new HandlerError({ status: 502, message: sessionResult.error.message })
  }

  const { sessionId: opencodeSessionId } = sessionResult.value

  const baseUrl = env.OPENCODE_BASE_URL ?? "http://opencode-auth:4096"
  const agent = selectAgent(sendMode)

  const opencodeResponse = await fetch(
    `${baseUrl}/api/sessions/${opencodeSessionId}/prompt`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.request.headers.get("authorization") ?? ""}`,
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: userMessage }],
        agent,
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

  return Result.ok(
    new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    }),
  )
}

export default createSafeRootHandler(config, handler)
