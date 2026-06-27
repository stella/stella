# opencode-stella Agentic Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Stella's custom AI chat/agent runtime with opencode's agent server, integrating Stella's MCP tools, Knowledge layer, and per-client plugins (M&A example) with Daytona sandbox and Stella auth.

**Architecture:** Phase 0 builds infrastructure (auth, multi-tenancy, sandboxing). Phase 1-6 migrate chat stack to opencode while preserving all existing guarantees (streaming, compaction, audit, anonymization, DOCX overlay).

**Tech Stack:** opencode serve (sidecar), @opencode-ai/sdk, @modelcontextprotocol/sdk, Daytona SDK, Bun, Elysia, Vercel AI SDK, Drizzle ORM.

---

## Phase 0: Infrastructure (Blockers from Spec Review)

### Task 0.0: Create Stub Files for Phase 0 Dependencies

**Files:**
- Create: `apps/api/src/handlers/chat/agent-proxy.ts` (stub)
- Create: `.opencode/plugins/workspace-loader.ts` (stub)

- [ ] **Step 1: Create agent-proxy.ts stub**

```typescript
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
```

- [ ] **Step 2: Create workspace-loader.ts stub**

```typescript
// .opencode/plugins/workspace-loader.ts
import { define } from "@opencode-ai/plugin/v2/promise"

export default define({
  id: "@stll/plugin-workspace-loader",
  setup: async () => { /* TODO */ },
})
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/handlers/chat/agent-proxy.ts .opencode/plugins/workspace-loader.ts
git commit -m "chore: add stub files for Phase 0 dependencies"
```

---

### Task 0.1: Auth Middleware — JWKS Validation Before opencode

**Files:**
- Create: `apps/api/src/lib/jwks-validator.ts`
- Create: `tests/lib/jwks-validator.test.ts`
- Create: `apps/api/src/middleware/opencode-auth.ts`
- Create: `tests/middleware/opencode-auth.test.ts`
- Modify: `docker-compose.override.yml`

- [ ] **Step 1: Write failing test for JWKS validator**

```typescript
// tests/lib/jwks-validator.test.ts
import { describe, it, expect } from "bun:test"
import { validateToken } from "@/api/lib/jwks-validator"

describe("validateToken", () => {
  it("rejects invalid token", async () => {
    const result = await validateToken("invalid", "http://localhost:3001")
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/lib/jwks-validator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement JWKS validator with better-result**

```typescript
// apps/api/src/lib/jwks-validator.ts
import { Result } from "better-result"
import { createRemoteJWKSet, jwtVerify } from "jose"

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null

const getJWKS = (issuer: string) => {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(new URL("/.well-known/jwks.json", issuer))
  }
  return jwksCache
}

export const validateToken = async (
  token: string,
  issuer: string
): Promise<Result<{ sub: string; org_id: string; scopes: string[] }, Error>> => {
  try {
    const { payload } = await jwtVerify(token, getJWKS(issuer), {
      issuer,
      audience: "stella-mcp",
    })
    return Result.ok({
      sub: payload.sub as string,
      org_id: payload.org_id as string,
      scopes: (payload.scopes as string[]) ?? [],
    })
  } catch (e) {
    return Result.err(e instanceof Error ? e : new Error("Token validation failed"))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/lib/jwks-validator.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for auth middleware**

```typescript
// tests/middleware/opencode-auth.test.ts
import { describe, it, expect } from "bun:test"
import { opencodeAuthMiddleware } from "@/api/middleware/opencode-auth"

describe("opencodeAuthMiddleware", () => {
  it("rejects request without Bearer token", async () => {
    const req = new Request("http://localhost", { method: "GET" })
    const res = await opencodeAuthMiddleware(req, async () => new Response("ok"))
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

- [ ] **Step 7: Implement auth middleware**

```typescript
// apps/api/src/middleware/opencode-auth.ts
import { validateToken } from "@/api/lib/jwks-validator"

export const opencodeAuthMiddleware = async (
  req: Request,
  next: () => Promise<Response>
) => {
  const auth = req.headers.get("authorization")
  if (!auth?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 })
  }
  const token = auth.slice(7)
  const result = await validateToken(token, new URL(req.url).origin)
  if (Result.isError(result)) {
    return new Response("Invalid token", { status: 401 })
  }
  const reqWithUser = new Request(req, { headers: new Headers(req.headers) })
  reqWithUser.headers.set("x-stella-user", result.value.sub)
  reqWithUser.headers.set("x-stella-org", result.value.org_id)
  reqWithUser.headers.set("x-stella-scopes", result.value.scopes.join(","))
  return next(reqWithUser)
}
```

- [ ] **Step 8: Run test to verify it passes**

- [ ] **Step 9: Add nginx auth proxy to docker-compose.override.yml**

```yaml
# docker-compose.override.yml
opencode-auth:
  image: nginx:alpine
  volumes:
    - ./nginx-opencode.conf:/etc/nginx/nginx.conf:ro
  ports:
    - "4096:4096"
  depends_on:
    - opencode
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/lib/jwks-validator.ts apps/api/src/middleware/opencode-auth.ts tests/lib/jwks-validator.test.ts tests/middleware/opencode-auth.test.ts docker-compose.override.yml
git commit -m "feat: add JWKS auth middleware for opencode sidecar"
```

---

### Task 0.2: Workspace-Scoped opencode Sessions (SafeId, RLS, better-result)

**Files:**
- Create: `apps/api/src/lib/opencode-session-manager.ts`
- Create: `tests/lib/opencode-session-manager.test.ts`
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts` (add imports)

- [ ] **Step 1: Write failing test for session manager**

```typescript
// tests/lib/opencode-session-manager.test.ts
import { describe, it, expect } from "bun:test"
import { getOrCreateSession } from "@/api/lib/opencode-session-manager"

describe("getOrCreateSession", () => {
  it("creates session per workspace with SafeId", async () => {
    const s1 = await getOrCreateSession("thread-1", "workspace-1", "user-token")
    const s2 = await getOrCreateSession("thread-2", "workspace-2", "user-token")
    expect(s1.sessionId).not.toBe(s2.sessionId)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement session manager with SafeId, better-result, RLS checks**

```typescript
// apps/api/src/lib/opencode-session-manager.ts
import { Result } from "better-result"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { validateWorkspaceAccess } from "@/api/lib/auth"
import { SafeId } from "@/api/lib/branded-types"

const sessionCache = new Map<string, { sessionId: string; workspaceId: SafeId<"workspace"> }>()

export const getOrCreateSession = async (
  threadId: SafeId<"chatThread">,
  workspaceId: SafeId<"workspace"> | null,
  userToken: string
): Promise<Result<{ sessionId: string; isNew: boolean }, Error>> => {
  const cacheKey = `${threadId}:${workspaceId ?? "global"}`
  const cached = sessionCache.get(cacheKey)
  if (cached) return Result.ok({ sessionId: cached.sessionId, isNew: false })

  const client = createOpencodeClient({
    baseUrl: "http://opencode-auth:4096",
    headers: { Authorization: `Bearer ${userToken}` },
  })

  const session = await client.session.create({
    body: { title: `Thread ${threadId}`, metadata: { workspaceId: workspaceId ?? null, threadId } },
  })

  sessionCache.set(cacheKey, { sessionId: session.id, workspaceId: workspaceId ?? "" as any })
  return Result.ok({ sessionId: session.id, isNew: true })
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/opencode-session-manager.ts tests/lib/opencode-session-manager.test.ts
git commit -m "feat: add workspace-scoped opencode session manager"
```

---

### Task 0.3: Daytona Sandbox for Plugin Tools

**Files:**
- Create: `apps/api/src/lib/daytona-sandbox.ts`
- Create: `tests/lib/daytona-sandbox.test.ts`
- Modify: `.opencode/plugins/workspace-loader.ts` (add sandbox hook)

- [ ] **Step 1: Write failing test for sandbox**

```typescript
// tests/lib/daytona-sandbox.test.ts
import { describe, it, expect } from "bun:test"
import { executeInSandbox } from "@/api/lib/daytona-sandbox"

describe("executeInSandbox", () => {
  it("runs tool in isolated workspace with Result", async () => {
    const result = await executeInSandbox("echo test", { cpu: 0.5, memory: 512, timeout: 30000 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.stdout).toContain("test")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement Daytona sandbox with Result**

```typescript
// apps/api/src/lib/daytona-sandbox.ts
import { Result } from "better-result"
import { Daytona } from "@daytonaio/sdk"

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY! })

export const executeInSandbox = async (
  command: string,
  limits: { cpu: number; memory: number; timeout: number }
): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, Error>> => {
  try {
    const sandbox = await daytona.create({ resources: { cpu: limits.cpu, memory: limits.memory } })
    const exec = await sandbox.process.exec(command, { timeout: limits.timeout })
    await sandbox.delete()
    return Result.ok({ stdout: exec.stdout, stderr: exec.stderr, exitCode: exec.exitCode })
  } catch (e) {
    return Result.err(e instanceof Error ? e : new Error("Sandbox execution failed"))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Add sandbox hook to workspace-loader.ts**

```typescript
// In workspace-loader.ts setup function:
ctx.integration.transform(async (draft) => {
  for (const tool of plugin.manifest.tools) {
    const originalExecute = tool.execute
    if (tool.sandbox === "daytona") {
      draft.method.update(tool.name, {
        execute: async (args, ctx) => {
          const result = await executeInSandbox(`node -e "${originalExecute.toString()}"`, {
            cpu: 0.5, memory: 512, timeout: 30000
          })
          if (Result.isError(result)) throw new Error(result.error.message)
          return result.value.stdout
        }
      })
    }
  }
})
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/daytona-sandbox.ts tests/lib/daytona-sandbox.test.ts .opencode/plugins/workspace-loader.ts
git commit -m "feat: add Daytona sandbox for plugin tools"
```

---

### Task 0.4: Tool Namespace Convention & Conflict Resolution (Valibot for config)

**Files:**
- Create: `apps/api/src/lib/tool-namespace.ts`
- Create: `tests/lib/tool-namespace.test.ts`
- Create: `apps/api/src/lib/tool-config-schema.ts` (Valibot)
- Modify: `.opencode/plugins/workspace-loader.ts` (apply namespacing)

- [ ] **Step 1: Write failing test for namespacing**

```typescript
// tests/lib/tool-namespace.test.ts
import { describe, it, expect } from "bun:test"
import { namespaceTool, resolveTool } from "@/api/lib/tool-namespace"

describe("namespaceTool", () => {
  it("prefixes tool with plugin id", () => {
    expect(namespaceTool("@stll/plugin-ma", "precedentSearch")).toBe("ma_precedentSearch")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement namespacing**

```typescript
// apps/api/src/lib/tool-namespace.ts
export const namespaceTool = (pluginId: string, toolName: string): string => {
  const prefix = pluginId.replace("@stll/plugin-", "").replace("/", "_")
  return `${prefix}_${toolName}`
}

export const resolveTool = (namespacedName: string, availableTools: string[]): string | null => {
  if (availableTools.includes(namespacedName)) return namespacedName
  const withoutPrefix = namespacedName.split("_").slice(1).join("_")
  return availableTools.includes(withoutPrefix) ? withoutPrefix : null
}
```

- [ ] **Step 4: Add Valibot schema for plugin manifest config**

```typescript
// apps/api/src/lib/tool-config-schema.ts
import * as v from "valibot"

export const PluginManifestSchema = v.strictObject({
  name: v.string(),
  version: v.string(),
  displayName: v.string(),
  category: v.string(),
  permissions: v.object({ required: v.array(v.string()), optional: v.array(v.string()) }),
  agents: v.array(v.string()),
  skills: v.array(v.string()),
  tools: v.array(v.object({ name: v.string(), sandbox: v.optional(v.string()) })),
  knowledgeIntegrations: v.optional(v.object({ templates: v.array(v.string()), clauses: v.array(v.string()), skills: v.array(v.string()) })),
})
```

- [ ] **Step 5: Apply namespacing in workspace-loader.ts when registering tools**

```typescript
// In workspace-loader.ts:
import { namespaceTool, resolveTool } from "@/api/lib/tool-namespace"
import { PluginManifestSchema } from "@/api/lib/tool-config-schema"

const manifest = v.parse(PluginManifestSchema, pluginManifest)
for (const tool of manifest.tools) {
  const namespaced = namespaceTool(manifest.name, tool.name)
  draft.method.update(namespaced, { execute: tool.execute })
}
```

- [ ] **Step 6: Run test to verify it passes**

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/tool-namespace.ts apps/api/src/lib/tool-config-schema.ts tests/lib/tool-namespace.test.ts .opencode/plugins/workspace-loader.ts
git commit -m "feat: add tool namespace convention and Valibot manifest schema"
```

---

### Task 0.5: SSE Transformation Spec & Implementation

**Files:**
- Create: `apps/api/src/lib/sse-transformer.ts`
- Create: `tests/lib/sse-transformer.test.ts`
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts` (integrate transformer)

- [ ] **Step 1: Document format mapping in code comments**

```typescript
// apps/api/src/lib/sse-transformer.ts
// STELLA SSE FORMAT (from stream-chat.ts):
// - text-delta: { type: "text-delta", id, delta }
// - tool-input-delta: { type: "tool-input-delta", toolCallId, inputTextDelta }
// - tool-output-available: { type: "tool-output-available", toolCallId, output }
// - text-end: { type: "text-end", id }
// - data-stella-anon-restorations: { type: "data-stella-anon-restorations", data: { pairs } }
// - error: { type: "error", errorText }
//
// OPENCODE SDK RETURNS: { info: AssistantMessage, parts: Part[] }
//
// TRANSFORMER MUST:
// 1. Convert opencode Part[] → Stella SSE chunks
// 2. Preserve anonymization restoration deltas
// 3. Map tool calls to Stella tool part format
// 4. Emit error chunks on failure
```

- [ ] **Step 2: Write failing test for transformer**

```typescript
// tests/lib/sse-transformer.test.ts
import { describe, it, expect } from "bun:test"
import { transformOpencodeToStellaSSE } from "@/api/lib/sse-transformer"

describe("transformOpencodeToStellaSSE", () => {
  it("converts opencode part to text-delta chunk", async () => {
    const opencodeStream = async function* () {
      yield { info: { id: "msg-1", role: "assistant" }, parts: [{ type: "text", text: "Hello" }] }
    }
    const chunks = []
    for await (const chunk of transformOpencodeToStellaSSE(opencodeStream(), {} as any)) {
      chunks.push(chunk)
    }
    expect(chunks.some(c => c.type === "text-delta")).toBe(true)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

- [ ] **Step 4: Implement transformer**

```typescript
// apps/api/src/lib/sse-transformer.ts
import type { ChatThirdPartyBoundary } from "@/api/handlers/chat/third-party-boundary"

export async function* transformOpencodeToStellaSSE(
  opencodeStream: AsyncIterable<{ info: any; parts: any[] }>,
  thirdPartyBoundary: ChatThirdPartyBoundary
) {
  for await (const { parts } of opencodeStream) {
    for (const part of parts) {
      if (part.type === "text") {
        yield { type: "text-delta", id: part.id ?? "msg", delta: part.text }
      } else if (part.type === "tool") {
        if (part.state === "input-streaming") {
          yield { type: "tool-input-delta", toolCallId: part.callId, inputTextDelta: JSON.stringify(part.input) }
        } else if (part.state === "output-available") {
          yield { type: "tool-output-available", toolCallId: part.callId, output: part.output }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/sse-transformer.ts tests/lib/sse-transformer.test.ts
git commit -m "feat: add SSE transformer for opencode → Stella chat format"
```

---

## Phase 1: Agent Proxy & Core Migration

### Task 1.1: Agent Proxy Handler (replaces send-message.ts streaming)

**Files:**
- Create: `apps/api/src/handlers/chat/agent-proxy.ts`
- Modify: `apps/api/src/handlers/chat/routes.ts` (replace sendMessage with agentProxy)
- Create: `tests/handlers/chat/agent-proxy.test.ts`

- [ ] **Step 1: Write failing test for agent proxy**

```typescript
// tests/handlers/chat/agent-proxy.test.ts
import { describe, it, expect } from "bun:test"
import { agentProxyHandler } from "@/api/handlers/chat/agent-proxy"

describe("agentProxyHandler", () => {
  it("creates opencode session and forwards message", async () => {
    // Mock opencode client, verify session.create + session.prompt called
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement agent proxy with feature flag**

```typescript
// apps/api/src/handlers/chat/agent-proxy.ts
import { createSafeRootHandler } from "@/api/lib/api-handlers"
import { getOrCreateSession } from "@/api/lib/opencode-session-manager"
import { transformOpencodeToStellaSSE } from "@/api/lib/sse-transformer"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { env } from "@/api/env"
import { Result } from "better-result"
import { panic } from "better-result"

const USE_OPENCODE_CHAT = env.USE_OPENCODE_CHAT === "true" // Feature flag

export const config = { /* ... */ }
export default createSafeRootHandler(config, async function* ({ /* context */ }) {
  if (!USE_OPENCODE_CHAT) {
    // Fallback to legacy sendMessage (import and delegate)
    const { default: sendMessage } = await import("./send-message")
    return yield* sendMessage.handler({ /* ... */ })
  }

  const sessionResult = yield* Result.await(getOrCreateSession(threadId, workspaceId, userToken))
  const opencode = createOpencodeClient({ baseUrl: "http://opencode-auth:4096", headers: { Authorization: `Bearer ${userToken}` } })

  const response = yield* Result.await(Result.tryPromise({
    try: async () => opencode.session.prompt({
      path: { id: sessionResult.value.sessionId },
      body: { parts: [{ type: "text", text: userMessage }], agent: "build" }
    }),
    catch: (e) => new HandlerError({ status: 500, message: "Opencode request failed", cause: e }),
  }))

  // Stream response via SSE transformer
  const stream = transformOpencodeToStellaSSE(response, thirdPartyBoundary)
  // Return SSE Response...
})
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Update routes.ts to use agentProxyHandler with feature flag**

```typescript
// apps/api/src/handlers/chat/routes.ts
import { agentProxy } from "./agent-proxy"
// Replace sendMessage with agentProxy
.post("/", agentProxy.handler, { body: agentProxy.config.body, permissions: agentProxy.config.permissions })
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/handlers/chat/agent-proxy.ts apps/api/src/handlers/chat/routes.ts tests/handlers/chat/agent-proxy.test.ts
git commit -m "feat: add agent proxy handler with opencode integration and feature flag"
```

---

### Task 1.2: Curated Legal Agents (per-file, test-first)

**Files (7 total):**
- Create: `.opencode/agents/case-law-researcher.md`
- Create: `.opencode/agents/template-designer.md`
- Create: `.opencode/agents/entity-manager.md`
- Create: `.opencode/agents/document-reviewer.md`
- Create: `.opencode/agents/contract-analyzer.md`
- Create: `.opencode/agents/compliance-checker.md`
- Create: `.opencode/skills/legal-citation-format/SKILL.md`

- [ ] **Step 1: Write failing test for first agent file**

```typescript
// tests/agents/case-law-researcher.test.ts
import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"

describe("case-law-researcher agent", () => {
  it("has correct frontmatter with Stella MCP permissions", () => {
    const content = readFileSync(".opencode/agents/case-law-researcher.md", "utf-8")
    expect(content).toContain("mcp_stella_*: allow")
    expect(content).toContain("mode: subagent")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Create agent file**

```markdown
--- # .opencode/agents/case-law-researcher.md
description: Searches case law across jurisdictions, analyzes citations, summarizes decisions
mode: subagent
model: anthropic/claude-haiku-4-20250514
temperature: 0.1
permission:
  read: allow
  edit: deny
  bash: deny
  mcp_stella_*: allow
  mcp_stella-anonymized_*: allow
skill:
  legal-citation-format: allow
---

You are a case law research specialist...
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Repeat Steps 1-4 for each of the remaining 6 files** (template-designer, entity-manager, document-reviewer, contract-analyzer, compliance-checker, legal-citation-format skill)

- [ ] **Step 6: Commit**

```bash
git add .opencode/agents/ .opencode/skills/
git commit -m "feat: add 6 curated legal agents and legal-citation-format skill"
```

---

### Task 1.3: Global Plugins (audit, legal-tools, i18n)

**Files:**
- Create: `.opencode/plugins/audit.ts`
- Create: `.opencode/plugins/legal-tools.ts`
- Create: `.opencode/plugins/i18n.ts`

- [ ] **Step 1: Write failing test for audit plugin**

```typescript
// tests/plugins/audit.test.ts
import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"

describe("audit plugin", () => {
  it("hooks tool.execute.after with Result", () => {
    const content = readFileSync(".opencode/plugins/audit.ts", "utf-8")
    expect(content).toContain("tool.execute.after")
    expect(content).toContain("audit_logs")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement audit plugin**

```typescript
// .opencode/plugins/audit.ts
export default async ({ client }) => ({
  "tool.execute.after": async ({ tool, args, sessionID }) => {
    await client.session.prompt({
      path: { id: sessionID },
      body: { noReply: true, parts: [{ type: "text", text: `AUDIT: ${tool} called with ${JSON.stringify(args)}` }] }
    })
    // Also POST to internal audit endpoint
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Repeat for legal-tools.ts and i18n.ts** (test → fail → implement → pass)

- [ ] **Step 6: Commit**

```bash
git add .opencode/plugins/
git commit -m "feat: add global plugins (audit, legal-tools, i18n)"
```

---

## Phase 2: Per-Client Plugin System

### Task 2.1: Workspace Loader Plugin (v2, full implementation)

**Files:**
- Modify: `.opencode/plugins/workspace-loader.ts` (replace stub)
- Create: `tests/plugins/workspace-loader.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/plugins/workspace-loader.test.ts
import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"

describe("workspace-loader plugin", () => {
  it("uses v2 promise API with agent/skill/integration transforms", () => {
    const content = readFileSync(".opencode/plugins/workspace-loader.ts", "utf-8")
    expect(content).toContain("@opencode-ai/plugin/v2/promise")
    expect(content).toContain("agent.transform")
    expect(content).toContain("skill.source")
    expect(content).toContain("integration.transform")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement full workspace-loader with v2 API, better-result, Valibot**

```typescript
// .opencode/plugins/workspace-loader.ts
import { define } from "@opencode-ai/plugin/v2/promise"
import { PluginManifestSchema } from "@/api/lib/tool-config-schema"
import { namespaceTool, resolveTool } from "@/api/lib/tool-namespace"
import { fetchWorkspacePlugins } from "@/api/lib/plugin-registry"

export default define({
  id: "@stll/plugin-workspace-loader",
  setup: async (ctx) => {
    ctx.agent.transform(async (draft) => {
      const workspaceId = getWorkspaceIdFromSession()
      const plugins = await fetchWorkspacePlugins(workspaceId)
      for (const plugin of plugins) {
        const manifest = v.parse(PluginManifestSchema, plugin.manifest)
        for (const agent of manifest.agents) {
          draft.update(agent.name, (a) => { a.prompt = agent.prompt; a.permission = agent.permission; a.tools.push(...manifest.tools.map(t => t.name)) })
        }
        for (const skill of manifest.skills) {
          ctx.skill.source({ name: skill.name, content: skill.body })
        }
      }
    })
    ctx.integration.transform(async (draft) => {
      for (const plugin of plugins) {
        const manifest = v.parse(PluginManifestSchema, plugin.manifest)
        for (const tool of manifest.tools) {
          const namespaced = namespaceTool(manifest.name, tool.name)
          draft.method.update(namespaced, { execute: tool.execute })
        }
      }
    })
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/workspace-loader.ts tests/plugins/workspace-loader.test.ts
git commit -m "feat: implement workspace-loader v2 plugin with dynamic agent/skill/tool registration"
```

---

### Task 2.2: Plugin Registry API & DB Schema

**Files:**
- Create: `apps/api/src/db/schema.ts` (add workspacePlugins table)
- Create: `apps/api/src/handlers/plugins/registry.ts`
- Create: `apps/api/src/handlers/plugins/routes.ts`
- Create: `tests/handlers/plugins/registry.test.ts`

- [ ] **Step 1: Write failing test for registry**

```typescript
// tests/handlers/plugins/registry.test.ts
import { describe, it, expect } from "bun:test"
import { listWorkspacePlugins } from "@/api/handlers/plugins/registry"

describe("plugin registry", () => {
  it("returns installed plugins for workspace", async () => {
    const result = await listWorkspacePlugins("workspace-1")
    expect(Result.isOk(result)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add workspacePlugins table to schema**

```typescript
// apps/api/src/db/schema.ts (add to schema)
export const workspacePlugins = pgTable("workspace_plugins", {
  workspaceId: safeId("workspace").notNull(),
  pluginId: text().notNull(),
  version: text().notNull(),
  config: jsonb().default({}),
  enabled: boolean().default(true),
  installedAt: timestamp().defaultNow(),
  installedBy: safeId("user").notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.pluginId] })])
```

- [ ] **Step 4: Implement registry handlers with SafeId, Valibot, better-result**

```typescript
// apps/api/src/handlers/plugins/registry.ts
import { Result } from "better-result"
import { v } from "valibot"
import { workspacePlugins } from "@/api/db/schema"
import { safeDb } from "@/api/db"

export const listWorkspacePlugins = async (workspaceId: SafeId<"workspace">): Promise<Result<Plugin[], Error>> =>
  Result.await(safeDb((tx) => tx.select().from(workspacePlugins).where(eq(workspacePlugins.workspaceId, workspaceId))))
```

- [ ] **Step 5: Run test to verify it passes**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/handlers/plugins/ tests/handlers/plugins/
git commit -m "feat: add plugin registry DB schema and API"
```

---

### Task 2.3: M&A Plugin Package

**Files:**
- Create: `packages/plugin-ma/opencode-plugin.json`
- Create: `packages/plugin-ma/agents/ma-deal-lead.md`
- Create: `packages/plugin-ma/agents/ma-due-diligence.md`
- Create: `packages/plugin-ma/agents/ma-spa-drafter.md`
- Create: `packages/plugin-ma/agents/ma-closing-checklist.md`
- Create: `packages/plugin-ma/skills/ma-precedent-search/SKILL.md`
- Create: `packages/plugin-ma/skills/ma-redline-comparison/SKILL.md`
- Create: `packages/plugin-ma/skills/ma-regulatory-filing/SKILL.md`
- Create: `packages/plugin-ma/tools/ma-precedent-search.ts`
- Create: `packages/plugin-ma/tools/ma-clause-library.ts`
- Create: `packages/plugin-ma/tools/ma-deal-tracker.ts`
- Create: `packages/plugin-ma/tools/ma-signature-coordinator.ts`
- Create: `packages/plugin-ma/hooks/audit-ma-events.ts`
- Create: `packages/plugin-ma/hooks/ma-permission-gate.ts`

- [ ] **Step 1: Write failing test for manifest**

```typescript
// tests/plugin-ma/manifest.test.ts
import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"

describe("@stll/plugin-ma", () => {
  it("has valid manifest with all required fields", () => {
    const manifest = JSON.parse(readFileSync("packages/plugin-ma/opencode-plugin.json", "utf-8"))
    expect(manifest.name).toBe("@stll/plugin-ma")
    expect(manifest.agents).toHaveLength(4)
    expect(manifest.skills).toHaveLength(3)
    expect(manifest.tools).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Create manifest and all 15 files** (test → fail → implement → pass per file)

```json
// packages/plugin-ma/opencode-plugin.json
{
  "name": "@stll/plugin-ma",
  "version": "1.0.0",
  "displayName": "M&A Practice Plugin",
  "category": "practice-area",
  "permissions": { "required": ["template:create", "entity:read", "entity:write"] },
  "agents": ["ma-deal-lead", "ma-due-diligence", "ma-spa-drafter", "ma-closing-checklist"],
  "skills": ["ma-precedent-search", "ma-redline-comparison", "ma-regulatory-filing"],
  "tools": ["ma-precedent-search", "ma-clause-library", "ma-deal-tracker", "ma-signature-coordinator"],
  "knowledgeIntegrations": { "templates": ["ma-spa", "ma-nda", "ma-loi"], "clauses": ["ma-indemnity", "ma-earnout", "ma-reps-warranties"], "skills": ["intake-to-draft", "check-against-rules"] }
}
```

```markdown
--- # packages/plugin-ma/agents/ma-deal-lead.md
description: Lead M&A deal agent — orchestrates due diligence, drafting, closing
mode: subagent
model: anthropic/claude-sonnet-4-20250514
permission:
  read: allow
  edit: allow
  mcp_stella_*: allow
  tool_ma_*: allow
skill:
  ma-precedent-search: allow
  ma-redline-comparison: allow
---
You are the M&A Deal Lead...
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-ma/
git commit -m "feat: add @stll/plugin-ma with 4 agents, 3 skills, 4 tools, hooks, resources"
```

---

### Task 2.4: Plugin Manager UI (per-file)

**Files:**
- Create: `apps/web/src/routes/_protected.workspaces.$workspaceId.plugins.tsx`
- Create: `apps/web/src/components/plugins/plugin-browser.tsx`
- Create: `apps/web/src/components/plugins/plugin-card.tsx`
- Create: `apps/web/src/components/plugins/plugin-detail.tsx`
- Create: `apps/web/src/hooks/useWorkspacePlugins.ts`

- [ ] **Step 1: Write failing test for plugin browser component**

```typescript
// tests/components/plugins/plugin-browser.test.tsx
import { describe, it, expect } from "bun:test"
import { render } from "@testing-library/react"
import { PluginBrowser } from "@/components/plugins/plugin-browser"

describe("PluginBrowser", () => {
  it("renders plugin cards with install button", () => {
    const { getByText } = render(<PluginBrowser plugins={[{ name: "@stll/plugin-ma", version: "1.0.0" }]} />)
    expect(getByText("@stll/plugin-ma")).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement plugin-browser.tsx**

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Repeat for plugin-card, plugin-detail, useWorkspacePlugins, route** (test → fail → implement → pass)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/_protected.workspaces.$workspaceId.plugins.tsx apps/web/src/components/plugins/ apps/web/src/hooks/useWorkspacePlugins.ts
git commit -m "feat: add Plugin Manager UI for per-workspace plugin installation"
```

---

## Phase 3: Chat Stack Parity

### Task 3.1: Compaction & Persistence Parity

**Files:**
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts` (add onFinish with compaction)

- [ ] **Step 1: Write failing test for compaction checkpoint scheduling**

```typescript
// tests/handlers/chat/agent-proxy-compaction.test.ts
import { describe, it, expect } from "bun:test"
import { scheduleChatCompactionCheckpoint } from "@/api/handlers/chat/agent-proxy"

describe("scheduleChatCompactionCheckpoint", () => {
  it("schedules checkpoint when messages exceed threshold", async () => {
    // Mock safeDb, orgAIConfig, verify checkpoint persisted
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add onFinish callback with compaction, data_workspace_ids expansion, title generation, audit**

```typescript
// In agent-proxy.ts onFinish:
const assistantWorkspaceIds = extractAssistantWorkspaceIds(resolvedResponseMessage.parts)
  .filter((id) => accessibleSet.has(id))
const expandResult = await expandThreadDataScope({
  currentDataWorkspaceIds: dataScopeAfterIncomingMessage,
  newWorkspaceIds: assistantWorkspaceIds,
  recordAuditEvent,
  safeDb,
  threadId: body.threadId,
  threadWorkspaceId: workspaceId,
})
if (Result.isError(expandResult)) return // Skip persist on failure

const persistResult = await persistMessage({ persistencePlan, recordAuditEvent, safeDb, threadId: body.threadId, userId: user.id, workspaceId })
if (Result.isOk(persistResult)) {
  scheduleChatCompactionCheckpoint({ /* ... */ })
  if (thread.type === "created") void generateThreadTitle({ /* ... */ })
}
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/handlers/chat/agent-proxy.ts tests/handlers/chat/agent-proxy-compaction.test.ts
git commit -m "feat: add compaction, data_workspace_ids expansion, audit parity in agent proxy"
```

---

### Task 3.2: Anonymization Mode Parity

**Files:**
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts` (agent selection, MCP routing)

- [ ] **Step 1: Write failing test for anonymized mode routing**

```typescript
// tests/handlers/chat/agent-proxy-anon.test.ts
import { describe, it, expect } from "bun:test"

describe("agent proxy anonymized mode", () => {
  it("uses stella-anonymized MCP and build-anonymized agent", async () => {
    // Verify MCP client and agent selection
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add sendMode → agent/MCP mapping**

```typescript
// In agent-proxy.ts:
const agentName = body.sendMode === CHAT_SEND_MODE.anonymized ? "build-anonymized" : "build"
const mcpServer = body.sendMode === CHAT_SEND_MODE.anonymized ? "stella-anonymized" : "stella"
// Pass mcpServer to opencode session prompt context
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/handlers/chat/agent-proxy.ts tests/handlers/chat/agent-proxy-anon.test.ts
git commit -m "feat: add anonymization mode parity in agent proxy"
```

---

### Task 3.3: DOCX Edit Tool Migration

**Files:**
- Create: `.opencode/tools/ma-apply-docx-edits.ts` (or in plugin-ma)
- Modify: `apps/api/src/handlers/chat/tools/active-docx-edit-tool.ts` (deprecate)

- [ ] **Step 1: Write failing test for opencode DOCX tool**

```typescript
// tests/tools/ma-apply-docx-edits.test.ts
import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"

describe("ma-apply-docx-edits tool", () => {
  it("has correct schema and execute", () => {
    const content = readFileSync(".opencode/tools/ma-apply-docx-edits.ts", "utf-8")
    expect(content).toContain("apply-active-docx-edits")
    expect(content).toContain("execute")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement opencode tool wrapping existing logic**

```typescript
// .opencode/tools/ma-apply-docx-edits.ts
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Apply DOCX edits from review store",
  args: { edits: tool.schema.array(tool.schema.object({ /* ... */ })) },
  async execute(args, ctx) {
    // Reuse existing applyActiveDocxEditTool logic via internal API call
    const response = await fetch("http://api:3001/internal/docx/apply-edits", {
      method: "POST", body: JSON.stringify(args), headers: { Authorization: `Bearer ${ctx.userToken}` }
    })
    return response.text()
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add .opencode/tools/ma-apply-docx-edits.ts
git commit -m "feat: migrate active-docx-edit tool to opencode custom tool"
```

---

### Task 3.4: Web Search Tool Migration

**Files:**
- Create: `.opencode/tools/web-search.ts`
- Modify: `apps/api/src/handlers/chat/tools/web-search-tools.ts` (deprecate)

- [ ] **Step 1: Write failing test**

- [ ] **Step 2: Implement web-search as opencode tool calling Tavily/Jina via internal endpoint**

- [ ] **Step 3: Run test to verify it passes**

- [ ] **Step 4: Commit**

---

## Phase 4: Deprecation & Cleanup

### Task 4.1: Verify Feature Flag Works

**Files:**
- Modify: `apps/api/src/handlers/chat/routes.ts` (keep sendMessage as fallback)
- Modify: `apps/api/env.ts` (add USE_OPENCODE_CHAT)

- [ ] **Step 1: Add env var**

```typescript
// apps/api/env.ts
export const env = {
  // ...
  USE_OPENCODE_CHAT: process.env.USE_OPENCODE_CHAT ?? "false",
}
```

- [ ] **Step 2: Test both modes (USE_OPENCODE_CHAT=true/false)**

- [ ] **Step 3: Commit**

```bash
git add apps/api/env.ts apps/api/src/handlers/chat/routes.ts
git commit -m "feat: add USE_OPENCODE_CHAT feature flag with legacy fallback"
```

---

### Task 4.2: Remove Legacy Chat Stack

**Files:**
- Delete: `apps/api/src/handlers/chat/send-message.ts`
- Delete: `apps/api/src/handlers/chat/stream-chat.ts`
- Delete: `apps/api/src/handlers/chat/chat-tools.ts`
- Delete: `apps/api/src/handlers/chat/skills.ts` (chat integration only)
- Delete: `apps/api/src/handlers/chat/compaction.ts`
- Delete: `apps/api/src/handlers/chat/persistent-compaction.ts`
- Delete: `apps/api/src/handlers/chat/persist-message.ts`
- Delete: `apps/api/src/handlers/chat/third-party-boundary.ts`
- Delete: `apps/api/src/handlers/chat/chat-prompt.ts`
- Delete: `apps/api/src/handlers/chat/chat-schema.ts`
- Delete: `apps/api/src/handlers/chat/chat-scope.ts`
- Delete: `apps/api/src/handlers/chat/data-scope.ts`
- Delete: `apps/api/src/handlers/chat/history-window.ts`
- Delete: `apps/api/src/handlers/chat/thread-anonymization.ts`
- Delete: `apps/api/src/handlers/chat/mcp-tool-parts.ts`
- Delete: `apps/api/src/handlers/chat/tools/execute/` (entire directory)
- Delete: `apps/api/src/handlers/chat/tools/active-docx-edit-tool.ts`
- Delete: `apps/api/src/handlers/chat/tools/active-docx-edit-tool-repair.ts`
- Delete: `apps/api/src/handlers/chat/tools/boe-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/business-registry-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/chat-history-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/create-document-tool.ts`
- Delete: `apps/api/src/handlers/chat/tools/external-mcp-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/infosoud-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/org-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/skill-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/template-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/web-search-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/workspace-tools.ts`
- Delete: `apps/api/src/handlers/chat/tools/tool-policy.ts`
- Delete: `apps/api/src/handlers/chat/tools/tool-schema.ts`
- Delete: `apps/api/src/handlers/chat/tools/tool-scope.ts`
- Delete: `apps/api/src/handlers/chat/tools/authorized-workspace-ids.ts`
- Delete: `apps/api/src/handlers/chat/tools/chat-tools.ts`

- [ ] **Step 1: Run full test suite to verify no regressions**

```bash
bun test
```

- [ ] **Step 2: Delete all legacy files**

```bash
git rm apps/api/src/handlers/chat/send-message.ts apps/api/src/handlers/chat/stream-chat.ts ...
```

- [ ] **Step 3: Update routes.ts to only use agentProxy**

```typescript
// apps/api/src/handlers/chat/routes.ts
.post("/", agentProxy.handler, { body: agentProxy.config.body, permissions: agentProxy.config.permissions })
```

- [ ] **Step 4: Run tests again to verify clean removal**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: remove legacy chat stack (send-message, stream-chat, chat-tools, etc.)"
```

---

### Task 4.3: Remove Feature Flag

**Files:**
- Modify: `apps/api/env.ts` (remove USE_OPENCODE_CHAT)
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts` (remove fallback)

- [ ] **Step 1: Remove fallback logic from agent-proxy.ts**

- [ ] **Step 2: Remove env var**

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove USE_OPENCODE_CHAT feature flag after validation"
```

---

## Convention Checklist (every implementation step must verify)

- [ ] **better-result**: All async operations use `Result.gen()`, `yield* Result.await()`, `Result.tryPromise()`, `Result.ok()`, `Result.err()`
- [ ] **Valibot**: All external input validated with `v.strictObject()`, `v.pipe()`, `v.array()`, `v.string()`, `v.number()`, `v.boolean()`
- [ ] **SafeId**: All workspace/entity/thread IDs use `SafeId<"type">`, validated with `validateWorkspaceAccess`
- [ ] **RLS**: All DB queries filter by `organizationId` and `workspaceId` (via `accessibleWorkspaceIds`)
- [ ] **Audit**: Every mutation calls `recordAuditEvent` with `AUDIT_ACTION` and `AUDIT_RESOURCE_TYPE`
- [ ] **Permissions**: Tool/agent permissions gate via `roles[memberRole].authorize({ resource: ["action"] })`

---

**Plan complete.** Ready for execution via subagent-driven-development or executing-plans.