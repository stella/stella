# 014: Categorized @Mentions in Chat

## Problem

The chat composer supports @mentions but only for entities
(documents, folders) inside the currently open matter. Global
chat has no mentions at all. Users cannot reference matters,
templates, contacts, or clauses in conversation with the AI.

## Goal

Expand @mentions to support multiple resource types, categorized
in the suggestion dropdown. Make global chat and workspace chat
offer the same quality of mention experience, differing only in
which categories are available.

The AI uses tools to crawl mentioned resources; mentions are
pointers, not context injection.

## Design

### Mention Types

| Type     | Trigger context    | Serialized format              | Icon       |
| -------- | ------------------ | ------------------------------ | ---------- |
| Entity   | Workspace chat     | `[Name](#stella-entity=ID)`    | doc/folder |
| Matter   | Global + workspace | `[Name](#stella-workspace=ID)` | scale      |
| Contact  | Global + workspace | `[Name](#stella-contact=ID)`   | user       |
| Template | Global + knowledge | `[Name](#stella-template=ID)`  | file-text  |
| Clause   | Global + knowledge | `[Name](#stella-clause=ID)`    | scroll     |

### Categorized Suggestion Dropdown

When the user types `@`, the dropdown groups results by
category with section headers:

```
In this matter          (only in workspace chat)
  Contract.pdf
  NDA.docx
  Discovery/
Matters
  Smith v. Jones
  Acme Acquisition
Contacts
  John Smith
  Acme Corp
Templates               (only on /knowledge or global)
  Engagement Letter
Clauses                  (only on /knowledge or global)
  Limitation of Liability
```

- Each section shows max 5 items, sorted by relevance
- Typing filters across all categories simultaneously
- Empty categories are hidden
- Section headers are non-selectable, styled as muted labels

### Data Sources

Each mention type needs a data source. Two strategies:

**Client-cached** (already loaded, instant):

- Entities: `useWorkspaceStore` (current)
- Matters: `workspacesOptions` query (sidebar already loads)

**Server-searched** (fetched on query, debounced):

- Contacts: `GET /contacts?q={query}&limit=5`
- Templates: `GET /templates?q={query}&limit=5`
- Clauses: `GET /clauses?q={query}&limit=5`

The suggestion plugin should support both: start with cached
data, then fire a debounced server search as the user types.
This keeps the dropdown snappy while supporting large datasets.

### Context Availability by Route

| Route                  | Available categories                  |
| ---------------------- | ------------------------------------- |
| `/workspaces/$id`      | Entities, Matters, Contacts           |
| `/knowledge/templates` | Templates, Clauses, Matters           |
| `/knowledge/clauses`   | Clauses, Templates, Matters           |
| `/contacts`            | Contacts, Matters                     |
| `/chat` (global)       | Matters, Contacts, Templates, Clauses |
| Any other              | Matters, Contacts                     |

This is driven by a `MentionContext` passed to `ChatEditor`:

```typescript
type MentionContext = {
  workspaceId?: string; // enables entity mentions
  categories: MentionCategory[];
};

type MentionCategory =
  | "entity" // documents, folders in current matter
  | "workspace" // matters
  | "contact"
  | "template"
  | "clause";
```

### Backend: Multi-Workspace Tools

Currently `createMatterTools()` is scoped to a single
`workspaceId`. When mentions reference other matters, the AI
needs tools that can operate across them.

**Approach**: the `sendMessages` action already receives the
serialized message text. Parse `#stella-workspace=ID` links
from the message, validate each against the user's org, and
pass the set of allowed workspace IDs to a new tool factory:

```typescript
// Existing (unchanged for workspace-scoped threads)
createMatterTools({ workspaceId, organizationId });

// New: for global chat or cross-matter references
createMultiMatterTools({
  allowedWorkspaceIds: SafeId < "workspace" > [],
  organizationId,
});
```

The multi-matter tools mirror the existing four but add a
required `workspaceId` parameter so the AI specifies which
matter to search/read:

- `searchMatter({ workspaceId, query, limit })`
- `listEntities({ workspaceId, kind?, parentId?, limit })`
- `readEntity({ workspaceId, entityId })`
- `readContent({ workspaceId, entityId })`

Security: the `allowedWorkspaceIds` set is built server-side
from validated mentions. The AI cannot access workspaces the
user didn't mention.

For non-matter mentions (contacts, templates, clauses), add
corresponding tools:

- `readContact({ contactId })` -- contact details
- `listTemplates({ query?, limit? })` -- search templates
- `readClause({ clauseId })` -- clause text

These are org-scoped (no workspace needed).

### System Prompt Updates

The system prompt should reflect what was mentioned:

```
The user has referenced the following in this conversation:
- Matter "Smith v. Jones" (workspace ID: abc)
- Matter "Acme Acquisition" (workspace ID: def)
- Contact "John Smith" (contact ID: ghi)

Use the available tools to explore these resources when
answering questions about them.
```

This replaces the current single-matter context block when
multiple resources are mentioned.

### Parsing Mentions from Messages

Add a utility to extract all mention references:

```typescript
type MentionRef =
  | { type: "entity"; id: string }
  | { type: "workspace"; id: string }
  | { type: "contact"; id: string }
  | { type: "template"; id: string }
  | { type: "clause"; id: string };

const parseMentions = (text: string): MentionRef[]
```

Used in:

1. `chat-actor.ts` to determine which tools to activate
2. `chat-source-transform.ts` to inject source chips
3. `UserMessageText` to render mention chips in messages

### Frontend Rendering

Mentions in messages (both user and assistant) render as
clickable chips, same as today. Extend the parsing in
`UserMessageText` and `EntityLink` to handle all link formats:

- `#stella-entity=ID` -- open entity in peek panel (existing)
- `#stella-workspace=ID` -- navigate to matter
- `#stella-contact=ID` -- open contact detail
- `#stella-template=ID` -- navigate to template
- `#stella-clause=ID` -- open clause detail

## Phases

### Phase 1: Categorized Dropdown + Matter Mentions

- Refactor `ChatMentionOption` to include a `category` field
- Refactor `ChatMentionList` to render grouped sections
- Add matter mentions sourced from `workspacesOptions` cache
- Update `MentionNode` to render matter icons
- Update serialization for `#stella-workspace=ID` format
- Update `UserMessageText` / `EntityLink` to parse new links
- Pass `MentionContext` instead of bare `workspaceId`

### Phase 2: Contact + Template + Clause Mentions

- Add server-searched mention sources (debounced fetch)
- Add contact, template, clause mention rendering
- Wire up route-specific `MentionContext` configurations

### Phase 3: Multi-Workspace Tools (Backend)

- Parse mentions from message text in `chat-actor.ts`
- Implement `createMultiMatterTools` with `workspaceId` param
- Add `readContact`, `listTemplates`, `readClause` tools
- Update system prompt builder for multi-resource context
- Update source injection transform for new mention types

### Phase 4: Global Chat Parity

- Enable full mention support on the `/chat` route
- Ensure thread metadata tracks all mentioned resource IDs
- Tools activate based on accumulated mentions across the
  conversation (not just the latest message)

## Non-Goals

- Context injection (auto-loading mentioned content into
  prompt). The AI should use tools to explore.
- Slash commands (`/search`, `/summarize`). That belongs
  to the Phase 5 skills system from plan 009.
- Cross-organization mentions. All mentions are org-scoped.

## Resolved Questions

1. Mentioning a matter in workspace chat adds it alongside
   the current one. The AI gets tools for both.
2. No cap on mentioned matters. Let the user decide.
3. Yes: zero-query state shows recent/frequent items
   immediately when the user types `@`.
