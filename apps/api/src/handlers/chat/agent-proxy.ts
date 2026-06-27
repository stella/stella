// apps/api/src/handlers/chat/agent-proxy.ts
import { createSafeRootHandler } from "@/api/lib/api-handlers"
import { HandlerError } from "@/api/lib/errors/tagged-errors"

export const config = {
  permissions: { chat: ["create"] },
  body: {} as any,
  requiresUsage: { actionType: "chat" },
} as const

export default createSafeRootHandler(config, async function* () {
  throw new HandlerError({ status: 501, message: "Not implemented yet" })
})
