# opencode-stella Agentic Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Stella's custom AI chat/agent runtime with opencode's agent server, integrating Stella's MCP tools, Knowledge layer, and per-client plugins (M&A example) with Daytona sandbox and Stella auth.

**Architecture:** Phase 0 builds infrastructure (auth, multi-tenancy, sandboxing). Phase 1-6 migrate chat stack to opencode while preserving all existing guarantees (streaming, compaction, audit, anonymization, DOCX overlay).

**Tech Stack:** opencode serve (sidecar), @opencode-ai/sdk, @modelcontextprotocol/sdk, Daytona SDK, Bun, Elysia, Vercel AI SDK, Drizzle ORM.

---

## Phase 0: Infrastructure (Blockers from Spec Review)

### Task 0.1: Auth Middleware — JWKS Validation Before opencode

**Files:**
- Create: `apps/api/src/middleware/opencode-auth.ts`
- Create: `apps/api/src/lib/jwks-validator.ts`
- Modify: `docker-compose.override.yml` (add auth proxy)

- [ ] **Step 1: Write failing test for JWKS validator**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement JWKS validator**
- [ ] **Step 4: Write auth middleware for opencode proxy**
- [ ] **Step 5: Update docker-compose with auth proxy (nginx)**
- [ ] **Step 6: Run test to verify it passes**
- [ ] **Step 7: Commit**

---

### Task 0.2: Workspace-Scoped opencode Sessions

**Files:**
- Create: `apps/api/src/lib/opencode-session-manager.ts`
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts` (new)

- [ ] **Step 1: Write failing test for session manager**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement session manager with workspace isolation**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 0.3: Daytona Sandbox for Plugin Tools

**Files:**
- Create: `apps/api/src/lib/daytona-sandbox.ts`
- Modify: `.opencode/plugins/workspace-loader.ts` (integrate sandbox)

- [ ] **Step 1: Write failing test for sandbox**
- [ ] **Step 2: Implement Daytona sandbox wrapper**
- [ ] **Step 3: Hook into workspace-loader for plugin tool execution**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 0.4: Tool Namespace Convention & Conflict Resolution

**Files:**
- Create: `apps/api/src/lib/tool-namespace.ts`
- Modify: `.opencode/plugins/workspace-loader.ts`

- [ ] **Step 1: Write failing test for namespacing**
- [ ] **Step 2: Implement namespacing**
- [ ] **Step 3: Apply in workspace-loader when registering tools**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 0.5: SSE Transformation Spec

**Files:**
- Create: `apps/api/src/lib/sse-transformer.ts`
- Modify: `apps/api/src/handlers/chat/agent-proxy.ts`

- [ ] **Step 1: Document Stella's SSE format vs opencode's format**
- [ ] **Step 2: Implement transformer**
- [ ] **Step 3: Integrate in Agent Proxy**
- [ ] **Step 4: Run integration test**
- [ ] **Step 5: Commit**

---

## Phase 1: Core Migration

### Task 1.1: Agent Proxy Handler (Replace send-message.ts)

**Files:**
- Create: `apps/api/src/handlers/chat/agent-proxy.ts`
- Modify: `apps/api/src/handlers/chat/routes.ts`
- Delete: `apps/api/src/handlers/chat/send-message.ts` (after migration)

- [ ] **Step 1: Write failing test for agent proxy**
- [ ] **Step 2: Implement agent-proxy.ts**
- [ ] **Step 3: Update routes.ts to use new handler**
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit**

---

### Task 1.2: Curated Legal Agents

**Files:**
- Create: `.opencode/agents/case-law-researcher.md`
- Create: `.opencode/agents/template-designer.md`
- Create: `.opencode/agents/entity-manager.md`
- Create: `.opencode/agents/document-reviewer.md`
- Create: `.opencode/agents/contract-analyzer.md`
- Create: `.opencode/agents/compliance-checker.md`
- Create: `.opencode/skills/legal-citation-format/SKILL.md`

- [ ] **Step 1: Write each agent markdown file** (6 agents + 1 skill)
- [ ] **Step 2: Test agents load in opencode**
- [ ] **Step 3: Commit**

---

## Phase 2: Plugin System

### Task 2.1: Workspace Loader Plugin (v2)

**Files:**
- Create: `.opencode/plugins/workspace-loader.ts`
- Create: `apps/api/src/api/plugins/[workspaceId].ts` (plugin registry API)

- [ ] **Step 1: Implement workspace-loader.ts**
- [ ] **Step 2: Create Plugin Registry API endpoints**
- [ ] **Step 3: Add plugin installation UI in web**
- [ ] **Step 4: Test: install plugin, verify agents appear in chat**
- [ ] **Step 5: Commit**

---

### Task 2.2: M&A Plugin (@stll/plugin-ma)

**Files:**
- Create: `packages/plugin-ma/` (full structure per spec)
- Modify: `package.json` (add to workspace)

- [ ] **Step 1: Scaffold plugin package**
- [ ] **Step 2: Write opencode-plugin.json manifest**
- [ ] **Step 3: Write 4 agents**
- [ ] **Step 4: Write 3 skills**
- [ ] **Step 5: Write 4 tools**
- [ ] **Step 6: Write 2 hooks**
- [ ] **Step 7: Add resources (precedents, clauses, checklists)**
- [ ] **Step 8: Test install in workspace → agents available in chat**
- [ ] **Step 9: Commit**

---

## Phase 3: Audit & Compliance

### Task 3.1: Audit Plugin

**Files:**
- Create: `.opencode/plugins/audit.ts`
- Modify: `apps/api/src/lib/audit-log.ts` (internal endpoint)

- [ ] **Step 1: Implement audit.ts hook**
- [ ] **Step 2: Verify audit logs capture all tool types**
- [ ] **Step 3: Commit**

---

## Phase 4: Deprecation

### Task 4.1: Remove Legacy Chat Stack

**Files:**
- Delete: `apps/api/src/handlers/chat/stream-chat.ts`
- Delete: `apps/api/src/handlers/chat/chat-tools.ts`
- Delete: `apps/api/src/handlers/chat/skills.ts` (chat integration only)
- Delete: `apps/api/src/handlers/chat/send-message.ts`
- Delete: `apps/api/src/handlers/chat/compaction.ts`
- Delete: `apps/api/src/handlers/chat/persistent-compaction.ts`

- [ ] **Step 1: Verify all features work via opencode**
- [ ] **Step 2: Delete files**
- [ ] **Step 3: Run full test suite** (`bun test`)
- [ ] **Step 4: Commit**

---

## Testing Checklist

- [ ] Unit tests for each new module (`bun test`)
- [ ] Integration test: full chat flow via opencode
- [ ] Multi-workspace isolation test
- [ ] Anonymized mode test
- [ ] Daytona sandbox test
- [ ] Plugin install/uninstall test
- [ ] Audit log coverage test
- [ ] Load test: 100 concurrent chat sessions

---

## Rollback Plan

If Phase 1 fails: feature flag `USE_OPENCODE_CHAT=false` in `send-message.ts` keeps legacy stack active.

---

## Timeline Estimate

| Phase | Tasks | Est. Days |
|-------|-------|-----------|
| 0 (Infrastructure) | 5 | 5 |
| 1 (Core Migration) | 2 | 3 |
| 2 (Plugin System) | 2 | 5 |
| 3 (Audit) | 1 | 1 |
| 4 (Deprecation) | 1 | 1 |
| **Total** | **11** | **15** |