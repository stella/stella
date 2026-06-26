# Design: opencode as Stella's Primary Agentic Engine

**Date:** 2026-06-26  
**Status:** Draft for Review  
**Decisions:** Approach A (Full Replacement), Daytona Sandbox, Stella Auth Passthrough, Curated Legal Agents, Per-Client Plugin System

---

## 1. Executive Summary

Replace Stella's custom AI chat/agent runtime (`send-message.ts`, `stream-chat.ts`, `chat-tools.ts`) with **opencode's battle-tested agent server** (`opencode serve`). All AI orchestration — streaming, tool loops, agent delegation, skill execution — moves to opencode. Stella's MCP server becomes the **domain tool provider**; opencode agents consume Stella's 20+ legal tools via MCP. Per-client practice-area plugins (M&A, Litigation, IP, etc.) are opencode plugins installed per workspace.

**Key principle:** Stella = **Legal Knowledge Layer** (templates, clauses, skills, case law). opencode = **Agentic Execution Layer** (agents, tools, plugins, sandbox).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Browser (Stella Web App)                           │
│         Chat UI · Entity UI · Template Studio · Knowledge UI                │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ HTTP
┌──────────────────────────────────▼──────────────────────────────────────────┐
│                    Stella API — Elysia (port 3001)                           │
│                                                                              │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐ │
│  │ Business Handlers   │  │ MCP Server          │  │ Agent Proxy Handler │ │
│  │ (entities,          │  │ (port 3001/mcp,     │  │ (NEW — forwards     │ │
│  │  workspaces,        │  │  /mcp-anonymized)   │  │  chat to opencode)  │ │
│  │  templates...)      │  │                     │  │                     │ │
│  └─────────────────────┘  └────────────┬────────┘  └──────────┬──────────┘ │
│                                        │ MCP                    │ SDK/HTTP    │
└────────────────────────────────────────┼────────────────────────┼────────────┘
                                         │                        │
                    ┌────────────────────▼────────────────────────▼─────────────┐
                    │              opencode serve (port 4096)                    │
                    │                                                             │
                    │  ┌─────────────────────────────────────────────────────┐   │
                    │  │ Agent Runtime                                        │   │
                    │  │ ┌────────┐ ┌────────┐ ┌──────────────────────────┐ │   │
                    │  │ │ Build  │ │ Plan   │ │ Custom Legal Agents      │ │   │
                    │  │ │ Agent  │ │ Agent  │ │ (case-law-researcher,    │ │   │
                    │  │ └────────┘ └────────┘ │  template-designer,      │ │   │
                    │  │ ┌────────┐ ┌────────┐ │  entity-manager,         │ │   │
                    │  │ │Explore │ │ General│ │  ma-deal-lead,           │ │   │
                    │  │ │ Agent  │ │ Agent  │ │  ma-due-diligence, ...)  │ │   │
                    │  │ └────────┘ └────────┘ └──────────────────────────┘ │   │
                    │  └─────────────────────────────────────────────────────┘   │
                    │  ┌─────────────────────────────────────────────────────┐   │
                    │  │ Plugin Engine (marketplace + local)                 │   │
                    │  │  ┌────────────────┐ ┌────────────────────────────┐  │   │
                    │  │  │ Marketplace    │ │ Local (@stll/plugin-*)     │  │   │
                    │  │  │ opencode-daytona│ │ • plugin-workspace-loader │  │   │
                    │  │  │ opencode-firecrawl│ │ • plugin-audit           │  │   │
                    │  │  │ opencode-bkgd-agents│ │ • plugin-legal-tools    │  │   │
                    │  │  │ @stll/plugin-ma │ │ • plugin-i18n            │  │   │
                    │  │  └────────────────┘ └────────────────────────────┘  │   │
                    │  └─────────────────────────────────────────────────────┘   │
                    │  ┌─────────────────────────────────────────────────────┐   │
                    │  │ Tool System                                         │   │
                    │  │  ┌──────────┐ ┌────────────┐ ┌──────────────────┐  │   │
                    │  │  │ Built-in │ │ Custom     │ │ MCP Client       │  │   │
                    │  │  │ (bash,   │ │ (.opencode/│ │ ──────────────►  │  │   │
                    │  │  │ read...) │ │  tools/)   │ │ Stella MCP Server│  │   │
                    │  │  └──────────┘ └────────────┘ └──────────────────┘  │   │
                    │  └─────────────────────────────────────────────────────┘   │
                    │  ┌─────────────────────────────────────────────────────┐   │
                    │  │ Sandbox Layer (Daytona)                             │   │
                    │  │  Trusted / Sandboxed / External per-agent config    │   │
                    │  └─────────────────────────────────────────────────────┘   │
                    └─────────────────────────────────────────────────────────────┘
```

---

## 3. Component Design

### 3.1 Agent Proxy Handler (`apps/api/src/handlers/chat/agent-proxy.ts`)

**Replaces** `send-message.ts` + `stream-chat.ts` streaming logic.

```typescript
// Core flow:
const session = await opencode.session.create({ body: { title: threadTitle } })
const response = await opencode.session.prompt({
  path: { id: session.id },
  body: { parts: [{ type: "text", text: userMessage }], agent: "build" }
})
```

**Responsibilities:**
- Map Stella `threadId` ↔ opencode `sessionId` (persist in `chat_threads.opencode_session_id`)
- Convert `ChatMessage` history → opencode session on first load
- Forward anonymization mode via agent selection (`build-anonymized` subagent)
- Handle `onFinish` to persist assistant message + expand `data_workspace_ids`

### 3.2 opencode Configuration (`.opencode/opencode.json`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "stella": {
      "type": "remote",
      "url": "http://localhost:3001/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:STELLA_SERVICE_TOKEN}" }
    },
    "stella-anonymized": {
      "type": "remote",
      "url": "http://localhost:3001/mcp-anonymized",
      "enabled": true
    }
  },
  "plugin": [
    "opencode-daytona",
    "@stll/plugin-audit",
    "@stll/plugin-legal-tools",
    "@stll/plugin-workspace-loader"
  ],
  "agent": {
    "build": { "permission": { "edit": "allow", "bash": "allow" } },
    "plan": { "permission": { "edit": "deny", "bash": "deny" } },
    "case-law-researcher": { "mode": "subagent", "model": "anthropic/claude-haiku-4-20250514" },
    "template-designer": { "mode": "subagent", "model": "anthropic/claude-sonnet-4-20250514" },
    },
   
    "entity-manager": { "mode": "subagent", "permission": { "edit": "ask" } },
    "document-reviewer": { "mode": "subagent", "permission": { "edit": "deny" } },
    "contract-analyzer": { "mode": "subagent", "model": "anthropic/claude-sonnet-4-20250514" },
    "compliance-checker": { "mode": "subagent", "permission": { "edit": "deny" } }
  },
  "permission": {
    "skill": { "*": "deny", "legal-*": "allow" },
    "mcp_stella_*": "allow",
    "mcp_stella-anonymized_*": "allow"
  }
}
```

### 3.3 Stella Plugins (`.opencode/plugins/`)

| Plugin | Purpose |
|--------|---------|
| `@stll/plugin-workspace-loader` (v2) | Dynamically loads workspace-installed plugins; registers agents, skills, tools, hooks |
| `@stll/plugin-audit` | `tool.execute.after` → writes to `audit_logs` with user/org/workspace context |
| `@stll/plugin-legal-tools` | Custom tools wrapping Stella REST endpoints for agents needing direct REST |
| `@stll/plugin-i18n` | Hooks for multi-language support |

### 3.4 Curated Legal Agents (`.opencode/agents/*.md`)

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

You are a case law research specialist for Stella legal workspace.

Available domain tools via Stella MCP:
- search_case_law, read_case_law_decision, list_matters, search_across_matters

Workflow: Clarify jurisdiction → Search → Read decisions → Map citations → Return structured brief
```

**Core agents:** `case-law-researcher`, `template-designer`, `entity-manager`, `document-reviewer`, `contract-analyzer`, `compliance-checker`

### 3.5 Per-Client Plugin System (M&A Example)

**Plugin Structure:**
```
@stll/plugin-ma/
├── opencode-plugin.json          # Manifest
├── agents/
│   ├── ma-deal-lead.md
│   ├── ma-due-diligence.md
│   ├── ma-spa-drafter.md
│   └── ma-closing-checklist.md
├── skills/
│   ├── ma-precedent-search/SKILL.md
│   ├── ma-redline-comparison/SKILL.md
│   └── ma-regulatory-filing/SKILL.md
├── tools/
│   ├── ma-precedent-search.ts
│   ├── ma-clause-library.ts
│   ├── ma-deal-tracker.ts
│   └── ma-signature-coordinator.ts
├── hooks/
│   ├── audit-ma-events.ts
│   └── ma-permission-gate.ts
└── resources/
    ├── precedents/, clauses/, checklists/
```

**Manifest (`opencode-plugin.json`):**
```json
{
  "name": "@stll/plugin-ma",
  "version": "1.0.0",
  "displayName": "M&A Practice Plugin",
  "category": "practice-area",
  "permissions": { "required": ["template:create", "entity:read", "entity:write"] },
  "agents": ["ma-deal-lead", "ma-due-diligence", "ma-spa-drafter", "ma-closing-checklist"],
  "skills": ["ma-precedent-search", "ma-redline-comparison", "ma-regulatory-filing"],
  "tools": ["ma-precedent-search", "ma-clause-library", "ma-deal-tracker", "ma-signature-coordinator"],
  "knowledgeIntegrations": {
    "templates": ["ma-spa", "ma-nda", "ma-loi"],
    "clauses": ["ma-indemnity", "ma-earnout", "ma-reps-warranties"],
    "skills": ["intake-to-draft", "check-against-rules"]
  }
}
```

**Installation Flow:**
```
Workspace Settings → Plugins → Install @stll/plugin-ma
  → Stella API downloads package, reads manifest
  → Registers agents in .opencode/agents/
  → Registers skills in .opencode/skills/
  → Registers tools in .opencode/tools/
  → Makes plugin templates/clauses available in workspace
  → opencode workspace-loader picks up new agents/skills/tools
  → Available immediately in chat
```

### 3.6 Workspace Loader Plugin (v2)

```typescript
// .opencode/plugins/workspace-loader.ts
import { define } from "@opencode-ai/plugin/v2/promise"

export default define({
  id: "@stll/plugin-workspace-loader",
  setup: async (ctx) => {
    ctx.agent.transform(async (draft) => {
      const workspaceId = getWorkspaceIdFromSession()
      const plugins = await fetchWorkspacePlugins(workspaceId)
      for (const plugin of plugins) {
        for (const agent of plugin.manifest.agents) {
          draft.update(agent.name, (a) => { /* ... */ })
        }
        for (const skill of plugin.manifest.skills) {
          ctx.skill.source({ name: skill.name, content: skill.body })
        }
      }
    })
    ctx.integration.transform(async (draft) => {
      for (const tool of plugin.manifest.tools) {
        draft.method.update(tool.name, { execute: tool.execute })
      }
    })
  }
})
```

### 3.7 Daytona Sandbox Integration

**Trigger:** Agents with `sandbox: daytona` in frontmatter, or user-created agents from Stella UI.

```markdown
--- # .opencode/agents/user-contract-analyzer.md
sandbox: daytona
---
```

**Mechanism:** `opencode-daytona` plugin intercepts `tool.execute.before` for sandboxed agents, spins up Daytona workspace, executes tools there with resource limits.

---

## 4. Knowledge Layer Integration

Stella's **Knowledge** (`/templates`, `/clauses`, `/skills`, `/template-recipes`, `/shortcuts`) is the **data layer**. opencode agents consume it via **MCP tools**.

| Stella Knowledge | opencode Consumption |
|------------------|---------------------|
| Templates | `mcp_stella_list_templates`, `mcp_stella_fill_template`, `mcp_stella_describe_template` |
| Clauses | `mcp_stella_search_across_matters` + template tools |
| Skills/Blueprints | Mapped to opencode **Skills** (SKILL.md) + **Agents** |
| Template Recipes | Custom agents using template tools |
| Shortcuts | opencode **Commands** |
| MCP Connectors | opencode **MCP Client** (already works) |

**Stella Skills → opencode Bridge:**

| Current (4 built-in + user DB) | opencode Equivalent |
|-------------------------------|---------------------|
| `answer-from-sources` | Skill `legal-research` + Agent `case-law-researcher` |
| `intake-to-draft` | Agent `template-designer` |
| `check-against-rules` | Skill `compliance-checker` |
| `blank` | Custom agent template |
| User skills (DB) | Migrated to `.opencode/skills/<name>/SKILL.md` |

---

## 5. Auth Bridge (Stella better-auth → opencode)

**No separate opencode password.**

1. Stella issues short-lived **service token** (JWT with `sub: stella-service`, `org_id`, scopes)
2. opencode server validates via Stella's JWKS (`/.well-known/jwks.json`)
3. Per-request: Agent Proxy extracts user's access token, forwards to opencode SDK
4. opencode's MCP client includes same token when calling Stella MCP

```typescript
// apps/api/src/lib/opencode-client.ts
export const createOpencodeClient = (userToken: string) =>
  createOpencodeClient({
    baseUrl: "http://opencode:4096",
    headers: { Authorization: `Bearer ${userToken}` }
  })
```

---

## 6. Data Flow: User Sends Chat Message

```
1. POST /api/chat { message, threadId, workspaceId, activeAgent? }
         │
2. Agent Proxy Handler
   - Load thread → get/create opencode sessionId
   - Create opencode client with user's access token
   - Forward message to opencode session
         │
3. opencode serve
   - Select agent (build / custom legal agent)
   - Build tool set: built-in + MCP(stella) + custom
   - If agent.sandbox=daytona → opencode-daytona wraps tool exec
   - Run agent loop (streamText internally)
         │
4. Tool calls to Stella MCP (Bearer = user's token)
   - Stella MCP validates scopes → executes handlers
         │
5. opencode streams SSE chunks → Agent Proxy forwards to browser
         │
6. onFinish callback
   - Persist assistant message to chat_threads
   - Expand data_workspace_ids via Stella API
   - Update opencode session mapping
```

---

## 7. Migration Strategy

| Phase | Deliverable | Files |
|-------|-------------|-------|
| **1** | `opencode.json`, `docker-compose.override.yml`, plugins | New: `opencode.json`, `docker-compose.override.yml`, `.opencode/plugins/{audit,legal-tools,workspace-loader}.ts` |
| **2** | Agent Proxy Handler replacing streaming logic | Modify: `send-message.ts`, `stream-chat.ts`; New: `agent-proxy.ts` |
| **3** | 6 curated legal agents + workspace loader | New: `.opencode/agents/*.md`, `.opencode/plugins/workspace-loader.ts` |
| **4** | Per-client plugin system + M&A plugin | New: `@stll/plugin-ma`, Plugin Registry API, UI |
| **5** | Stella UI: Agent Manager + Plugin Manager | New: web routes/components |
| **6** | Deprecate legacy chat stack | Remove: `stream-chat.ts`, `chat-tools.ts`, `skills.ts` chat integration |

---

## 8. Success Criteria

- [ ] All existing chat features work via opencode (streaming, tools, anonymization)
- [ ] Marketplace plugins install and work (`opencode-daytona`, `opencode-firecrawl`, etc.)
- [ ] Curated legal agents invoke Stella MCP tools correctly
- [ ] Per-client plugins (M&A) install per workspace, agents/skills/tools available immediately
- [ ] Daytona sandbox isolates untrusted agents (resource limits, network policy)
- [ ] Auth flows through Stella better-auth (no separate credentials)
- [ ] Audit logs capture every tool execution via `@stll/plugin-audit`
- [ ] Zero regression in chat UX (same SSE format, same latency)
- [ ] Stella's Knowledge UI remains the single source of truth for templates/clauses/skills

---

## 9. Open Questions for Review

1. **Plugin runtime**: Confirm opencode v2 plugin API is stable for `@stll/plugin-workspace-loader`
2. **Plugin sandbox**: Should plugin code execution also run in Daytona, or trusted?
3. **Versioning**: How to handle plugin upgrades across workspaces (semver + migration)?
4. **Conflict resolution**: Two plugins define same tool — namespace as `ma_precedentSearch`?
5. **Resource bundling**: Precedents/clauses loaded at install or on-demand via plugin manifest?

---

## 10. Appendix: File Tree Changes

```
stella/
├── opencode.json                          # NEW
├── docker-compose.override.yml            # NEW (opencode sidecar)
├── .opencode/
│   ├── opencode.json                      # symlink to root
│   ├── agents/
│   │   ├── case-law-researcher.md         # NEW
│   │   ├── template-designer.md           # NEW
│   │   ├── entity-manager.md              # NEW
│   │   ├── document-reviewer.md           # NEW
│   │   ├── contract-analyzer.md           # NEW
│   │   └── compliance-checker.md          # NEW
│   ├── plugins/
│   │   ├── audit.ts                       # NEW
│   │   ├── legal-tools.ts                 # NEW
│   │   ├── workspace-loader.ts            # NEW (v2)
│   │   └── i18n.ts                        # NEW
│   └── skills/
│       └── legal-citation-format/
│           └── SKILL.md                   # NEW
├── apps/api/src/handlers/chat/
│   ├── agent-proxy.ts                     # NEW (replaces send-message streaming)
│   └── [legacy files deprecated]
├── packages/
│   └── plugin-ma/                         # NEW (per-client plugin)
│       ├── opencode-plugin.json
│       ├── agents/, skills/, tools/, hooks/, resources/
└── docs/superpowers/specs/
    └── 2026-06-26-opencode-stella-agentic-engine-design.md
```

---

**Ready for spec review loop. Please review and approve to proceed to implementation plan.**