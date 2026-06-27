import { Result } from "better-result"

import { env } from "@/api/env"
import { SandboxError } from "@/api/lib/errors/tagged-errors"

type SandboxLimits = {
  cpu: number
  memory: number
  timeout: number
}

type SandboxResult = {
  stdout: string
  stderr: string
  exitCode: number
}

const getClient = () => {
  const baseUrl = env.DAYTONA_BASE_URL ?? "http://localhost:3980"
  const apiKey = env.DAYTONA_API_KEY
  return { baseUrl, apiKey }
}

export const executeInSandbox = async (
  command: string,
  limits: SandboxLimits,
): Promise<Result<SandboxResult, SandboxError>> => {
  const { baseUrl, apiKey } = getClient()

  try {
    const createRes = await fetch(`${baseUrl}/sandboxes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        resources: { cpu: limits.cpu, memory: limits.memory },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!createRes.ok) {
      return Result.err(new SandboxError({
        reason: "runtime",
        message: `Failed to create sandbox: ${createRes.status}`,
      }))
    }

    const sandbox = (await createRes.json()) as { id: string }
    const sandboxId = sandbox.id

    try {
      const execRes = await fetch(`${baseUrl}/sandboxes/${sandboxId}/exec`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(limits.timeout),
      })

      if (!execRes.ok) {
        return Result.err(new SandboxError({
          reason: execRes.status === 408 ? "timeout" : "runtime",
          message: `Execution failed: ${execRes.status}`,
        }))
      }

      const exec = (await execRes.json()) as { stdout: string; stderr: string; exitCode: number }
      return Result.ok({ stdout: exec.stdout, stderr: exec.stderr, exitCode: exec.exitCode })
    } finally {
      await fetch(`${baseUrl}/sandboxes/${sandboxId}`, {
        method: "DELETE",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {})
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      return Result.err(new SandboxError({ reason: "timeout", message: "Sandbox operation timed out" }))
    }
    return Result.err(new SandboxError({ reason: "runtime", message: "Sandbox network error", cause: e }))
  }
}
