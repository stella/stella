# 009: Matter-Context Chat with Bash Tool

## Goal

Make the right-panel chat "always connected" to whatever the
user is looking at on the left. Starting with the Matter view:
when a workspace is open, the AI can search documents, read
entity metadata, and access file content within that matter
using the AI SDK Bash tool pattern. This gives the chat
first-class tool support for both **skills** and **currently
open matters**.

## Current State

- **Chat actor** (`chat-actor.ts`): Stateless `streamText` call
  to Gemini 2.5 Flash via OpenRouter. No tools, no context
  about the current workspace. Threads are ephemeral in-memory.
- **Search**: PostgreSQL FTS via `search_documents` table
  (tsvector). Supports workspace-scoped queries. No embeddings.
- **Extracted content**: `extracted_content` table stores
  encrypted full-text per entity (ciphertext + iv).
- **Entity model**: entities → versions → fields (property
  values). Properties define columns (file, text, select, date,
  checkbox, link, button).
- **Right panel**: `RightPanelChat` component renders inside
  `_protected.tsx`. Currently has no knowledge of workspaceId.

## Architecture

### Not Using `bash-tool` npm Package

The `bash-tool` package is designed for sandboxed filesystem
access (in-memory or Vercel Sandbox VM). Our use case is
different: we want the AI to query our own database and APIs.
We should follow the **pattern** (server-side tools that the
AI can invoke in a loop) but implement custom tools that call
our existing handlers directly.

### Approach: Server-Side AI SDK Tools on the Chat Actor

```
┌─────────────────────────────────────────────────────┐
│ Frontend (right-panel-chat.tsx)                      │
│  - Passes workspaceId to chat actor on thread create │
│  - Renders tool call results (expandable cards)      │
└──────────────────────┬──────────────────────────────┘
                       │ RivetKit connection
┌──────────────────────▼──────────────────────────────┐
│ Chat Actor (chat-actor.ts)                           │
│  - Receives workspaceId as thread metadata           │
│  - streamText() with tools:                          │
│    ├── searchMatter   (FTS within workspace)         │
│    ├── listEntities   (list files/docs + metadata)   │
│    ├── readEntity     (get entity details + fields)  │
│    ├── readContent    (get extracted text of a doc)   │
│    └── (future: skills)                              │
│  - maxSteps: 5 (tool loop)                           │
└─────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Thread-Level Workspace Context

**Goal**: Chat threads know which workspace they belong to.

#### 1.1 Extend thread metadata

File: `apps/api/src/handlers/registry/actors/chat-actor.ts`

```typescript
type ThreadMetadata = {
  title: string;
  createdAt: number;
  workspaceId: string | null; // NEW
};
```

Update `sendMessages` action to accept `workspaceId`:

```typescript
sendMessages: (c, input: {
  threadId: string;
  chatId: string;
  message: UIMessage;
  workspaceId?: string;  // NEW — optional for non-matter chats
}) => { ... }
```

Store `workspaceId` in thread metadata on creation. Skip for
threads created from `/chat` (global chat page).

#### 1.2 Pass workspaceId from frontend

File: `apps/web/src/components/right-panel-chat.tsx`

- `RightPanelChat` needs to receive `workspaceId` as a prop
  (or read from route match)
- Thread creation in `NewChat.onSubmit` passes `workspaceId`
  to `chat.sendMessage()`

File: `apps/web/src/routes/_protected.tsx`

- `RightPanel` reads `workspaceId` from route match
  (already done for other components) and passes to
  `LazyRightPanelChat`

#### 1.3 Update transport layer

File: `apps/web/src/lib/ai-sdk/rivet-transport.ts`

The `RivetChatTransport.sendMessages` method calls
`connection.sendMessages()`. We need to thread `workspaceId`
through to the actor. Options:

- **Option A**: Add `workspaceId` to the Rivet connection's
  `sendMessages` call (simple, direct)
- **Option B**: Set workspace context once on connect, not
  per-message

**Recommended: Option A** — simpler, no state to sync. The
actor stores it in thread metadata on first message.

Update `ChatStreamConnection.sendMessages` type and
`RivetChatTransport` to accept and forward `workspaceId`.

The `Chat` class from `@ai-sdk/react` sends messages via
its transport. We may need to pass `workspaceId` in the
`body` option of `useChat` or extend the transport.

### Phase 2: Server-Side Tools

**Goal**: Give the AI tools to query the current workspace.

#### 2.1 Define tool schemas

File: `apps/api/src/handlers/registry/actors/chat-tools.ts`
(new file)

```typescript
import { tool } from "ai";
import { z } from "zod";

export const createMatterTools = (
  workspaceId: string,
  organizationId: string,
) => ({
  searchMatter: tool({
    description:
      "Search for documents and files within the current " +
      "matter/workspace using full-text search. Returns " +
      "matching entity names with highlighted excerpts.",
    parameters: z.object({
      query: z.string().describe("The search query (keywords, phrases)"),
      limit: z.number().optional().default(10),
    }),
    execute: async ({ query, limit }) => {
      // Call searchHandler or provider directly
      // Scope to workspaceId + organizationId
    },
  }),

  listEntities: tool({
    description:
      "List documents, files, tasks, and folders in the " +
      "current matter. Returns names, types, dates, and " +
      "custom property values (metadata columns). Use " +
      "this to understand what's in the matter.",
    parameters: z.object({
      kind: z
        .enum(["document", "folder", "task", "file"])
        .optional()
        .describe("Filter by entity type"),
      parentId: z
        .string()
        .optional()
        .describe("List contents of a specific folder"),
    }),
    execute: async ({ kind, parentId }) => {
      // Query entities + properties for workspace
      // Return structured metadata
    },
  }),

  readEntity: tool({
    description:
      "Get detailed information about a specific entity " +
      "(document/file/task) including all its property " +
      "values (custom metadata columns).",
    parameters: z.object({
      entityId: z.string().describe("The entity ID"),
    }),
    execute: async ({ entityId }) => {
      // Fetch entity with fields, verify workspace scope
    },
  }),

  readContent: tool({
    description:
      "Read the extracted text content of a document or " +
      "file. Use this when you need to read the actual " +
      "contents of a document, not just its metadata.",
    parameters: z.object({
      entityId: z.string().describe("The entity ID"),
    }),
    execute: async ({ entityId }) => {
      // Fetch + decrypt extracted_content
      // Verify workspace scope
    },
  }),
});
```

#### 2.2 Wire tools into streamText

File: `apps/api/src/handlers/registry/actors/chat-actor.ts`

When a thread has a `workspaceId`, pass tools to `streamText`:

```typescript
const tools = thread.metadata.workspaceId
  ? createMatterTools(thread.metadata.workspaceId, organizationId)
  : undefined;

const stream = streamText({
  model,
  messages: await convertToModelMessages(messages),
  tools,
  maxSteps: 5, // Allow tool-use loops
  abortSignal: runSignal,
});
```

#### 2.3 System prompt

When workspace context is present, prepend a system message:

```
You are Stella, an AI assistant for legal professionals.
You are currently connected to the matter "{matterName}".
You can search documents, list files, and read content
within this matter using the available tools.

When the user asks about the matter contents, use tools
to find relevant information before answering. Cite
specific documents when referencing information.

The matter currently contains {entityCount} entities.
```

Fetch workspace name + entity count at thread creation or
lazily on first message.

### Phase 3: View-Aware Context

**Goal**: Adapt the system prompt and tool behavior based on
the active view (files vs table).

#### 3.1 Pass active view type from frontend

The frontend knows which view is active (`activeView.layout`:
`table` | `kanban` | `gallery`). Pass this alongside
`workspaceId` on message send.

When `layout === "table"`:

- System prompt emphasizes: "The user is viewing entities in
  a table with columns: {propertyNames}. They may ask about
  filtering, sorting, or analyzing the metadata."
- `listEntities` response includes full property values
  (matching the columns the user sees)

When `layout !== "table"` (files view):

- System prompt emphasizes: "The user is viewing files and
  folders. They may ask about document contents."
- `readContent` tool is highlighted in the prompt

#### 3.2 Property-aware responses

Fetch workspace properties and include them in the system
prompt so the AI understands the column schema:

```
Available metadata columns:
- Status (singleSelect): Pending, In Review, Final
- Due Date (date)
- Assigned To (text)
- Confidential (checkbox)
```

### Phase 4: Frontend Tool Call Rendering

**Goal**: Show tool calls and results in the chat UI.

#### 4.1 Render tool invocations

File: `apps/web/src/components/right-panel-chat.tsx`

The `UIMessage.parts` array includes `tool-invocation` parts
when the AI uses tools. Render them as expandable cards:

```
┌─ 🔍 Searched "contract amendment" ─────────┐
│  Found 3 results:                            │
│  • Amendment_v2.docx (98% match)             │
│  • Original_Contract.pdf                     │
│  • Amendment_Notes.md                        │
└──────────────────────────────────────────────┘
```

Add a `ToolCallCard` component that handles each tool type
with appropriate formatting.

#### 4.2 Handle streaming with tool steps

The AI SDK's `toUIMessageStream` already handles multi-step
tool calls. The existing `stream-chunk` event broadcasting
should carry tool invocation parts transparently. Verify
that the RivetChatTransport correctly passes these through.

### Phase 5: Skills

**Goal**: Pluggable domain skills that extend the chat's
capabilities depending on what the user is doing.

#### What is a Skill?

A skill is a named bundle of:

1. **Tools** — AI SDK `tool()` definitions (same pattern as
   matter tools)
2. **System prompt fragment** — appended to the base system
   prompt to give the AI domain knowledge
3. **Activation context** — when the skill becomes available

#### Skill Activation Model

Skills activate based on where the user is in the app:

| Route context                | Active skills               |
| ---------------------------- | --------------------------- |
| `/workspaces/$id` (files)    | matter-search, matter-read  |
| `/workspaces/$id` (table)    | matter-search, matter-meta  |
| `/knowledge/templates`       | template-management         |
| `/knowledge/clauses`         | clause-search, clause-draft |
| `/workspaces/$id/invoices`   | invoice-query               |
| `/workspaces/$id/timesheets` | timesheet-query             |
| Global (no route context)    | (base chat only)            |

The frontend passes an **activation context** alongside
`workspaceId` when creating a thread:

```typescript
type ChatContext = {
  workspaceId?: string;
  skills?: string[]; // e.g., ["matter-search", "matter-read"]
  viewLayout?: "table" | "files" | "kanban";
};
```

The chat actor uses `skills` to select which tool bundles
to load.

#### Skill Registry

Server-side registry maps skill names to tool factories:

```
apps/api/src/handlers/registry/actors/skills/
├── index.ts           # Registry: skillName → factory
├── matter-search.ts   # searchMatter tool (already built)
├── matter-read.ts     # readEntity, readContent
├── matter-meta.ts     # listEntities with full metadata
├── template-mgmt.ts   # list/search/preview templates
├── clause-search.ts   # search clause library
├── clause-draft.ts    # draft new clauses
├── invoice-query.ts   # query invoices for workspace
└── timesheet-query.ts # query time entries
```

Each skill file exports:

```typescript
export const matterSearchSkill = {
  name: "matter-search",
  systemPrompt: "You can search documents in the matter...",
  createTools: (ctx: SkillContext) => ({
    searchMatter: tool({ ... }),
  }),
};
```

#### Skill Composition

When the chat actor receives a message, it:

1. Reads `thread.metadata.skills` (set on thread creation)
2. Looks up each skill in the registry
3. Merges all tool sets into one `tools` object
4. Concatenates system prompt fragments
5. Passes to `streamText({ tools, system })`

This replaces the current `createMatterTools` with a more
general pattern. The existing matter tools become the first
two skills in the registry.

#### Future: User-Defined Skills

Organizations could eventually define custom skills via the
UI (prompt + tool configuration stored in DB). This is
deliberately deferred; the registry pattern supports it
without changes to the chat actor.

#### Future: Skill Discovery

The AI could be given a meta-tool (`selectSkill`) that lets
it request activation of additional skills mid-conversation.
For example, if a user asks "find a clause for this" while
in a matter, the AI could activate `clause-search` on demand.

## Migration Path

1. **Phase 1** can land independently (no breaking changes,
   threads just gain optional workspace metadata)
2. **Phase 2** requires Phase 1 but is also backward-compatible
   (global chat threads without workspaceId still work)
3. **Phase 3** is a refinement of Phase 2
4. **Phase 4** can develop in parallel with Phase 2

## Security Considerations

- **Workspace scoping**: Every tool execution MUST verify the
  entity belongs to the thread's workspace. Use the same
  `SafeId` pattern as existing handlers.
- **Organization scoping**: The actor already validates the
  session. Extract `organizationId` from the connection state.
- **Extracted content decryption**: Only decrypt when the user
  has access to the workspace. The actor's session validation
  already ensures this.
- **Rate limiting**: `maxSteps: 5` prevents runaway tool loops.
  Consider per-thread rate limiting for `readContent` (expensive).
- **No raw SQL**: All tool implementations use Drizzle ORM.
- **Content size**: Truncate `readContent` results to avoid
  blowing up the context window (e.g., max 8000 chars).

## Decisions

1. **Thread scoping**: Workspace-scoped. Separate thread list
   per matter. Matches the "always connected" mental model.

2. **Extracted content availability**: `readContent` tool
   gracefully handles missing content — returns a message
   telling the AI the content hasn't been extracted yet.

3. **Model choice**: Configurable. In DEV, expose a model
   selector (e.g., gemini-3.0-flash, gemini-2.5-flash).
   Default remains gemini-2.5-flash. Model selection stored
   as env var or dev-only UI toggle.

4. **Token budget**: Always send max 4 preceding messages
   (sliding window). System prompt + tool defs + last 4
   messages only. Keeps context tight and costs predictable.
