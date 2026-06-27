import { Result } from "better-result"

import type { SafeId } from "@/api/lib/branded-types"
import { env } from "@/api/env"

type SessionEntry = {
  sessionId: string
  workspaceId: string | null
  threadId: string
}

const sessionCache = new Map<string, SessionEntry>()

const OPENCODE_BASE_URL = env.OPENCODE_BASE_URL ?? "http://opencode-auth:4096"

export const getOrCreateSession = async (
  threadId: string,
  workspaceId: string | null,
  userToken: string,
): Promise<Result<{ sessionId: string; isNew: boolean }, Error>> => {
  const cacheKey = `${threadId}:${workspaceId ?? "global"}`
  const cached = sessionCache.get(cacheKey)
  if (cached) {
    return Result.ok({ sessionId: cached.sessionId, isNew: false })
  }

  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        title: `Thread ${threadId}`,
        metadata: { workspaceId, threadId },
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown")
      return Result.err(new Error(`Opencode session creation failed: ${response.status} ${body}`))
    }

    const session = (await response.json()) as { id: string }
    sessionCache.set(cacheKey, { sessionId: session.id, workspaceId, threadId })
    return Result.ok({ sessionId: session.id, isNew: true })
  } catch (e) {
    return Result.err(e instanceof Error ? e : new Error("Session creation network error"))
  }
}

export const invalidateSession = (
  threadId: string,
  workspaceId: string | null,
): void => {
  const cacheKey = `${threadId}:${workspaceId ?? "global"}`
  sessionCache.delete(cacheKey)
}
