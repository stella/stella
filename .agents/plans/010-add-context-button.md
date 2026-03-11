# 010: Add Context Button for Chat

## Goal

Replace the `@`-mention autocomplete approach with an explicit
"Add context" button in the chat prompt footer. The button opens
a popover with three options:

1. **Current matter** -- pick entities from the workspace the
   user is currently viewing
2. **Other matter** -- pick entities from a different workspace
3. **Upload file** -- attach a local file directly to the message

Selected items appear as removable chips above the textarea.
The context is sent alongside the message text and injected
into the model conversation as structured content.

## Current State

- **@-mention**: `MentionablePromptArea` wraps the prompt input
  and watches for `@` keystrokes. It opens
  `EntityMentionPopover`, which searches the current workspace's
  entities via the Zustand `useWorkspaceStore`. On selection, it
  injects a markdown link `[Name](#stella-entity=ID)` into the
  textarea.
- **Limitations**: (a) the markdown link syntax is ugly and
  visible to the user; (b) only works inside a matter
  (no workspace store outside `/workspaces/$id`); (c) no
  cross-workspace entity picking; (d) no file upload; (e) the
  model receives these as raw text, not structured context.
- **AI SDK sendMessage**: Already supports `files: FileList |
FileUIPart[]` alongside `text`. User messages can have both
  text parts and file parts. The `FileUIPart` type carries
  `mediaType`, `url` (data URL or hosted URL), and optional
  `filename`.
- **Chat actor tools**: `readEntity` and `readContent` verify
  workspace scope (`workspaceId`). Cross-workspace reads are
  blocked by design (tool only reads from the thread's
  workspace).
- **Entity data flow**: Inside a matter, entities are loaded
  into `useWorkspaceStore` via `entitiesOptions(workspaceId)`.
  Outside a matter, there is no entity store in scope. The
  workspaces list is available via `workspacesOptions`.
- **File upload**: `useCreateFileEntities` handles file upload
  to a workspace. `AddEntityMenu` uses a hidden `<input
type="file">` for the file picker. `DropZone` uses
  `react-aria` drag-and-drop. Files are uploaded via
  `api.entities({workspaceId}).upload.post()`.
- **Search**: `searchHandler` accepts an optional `workspaceId`
  and scopes search to the org. The FTS provider supports both
  workspace-scoped and org-wide search. The chat tool
  `searchMatter` currently only searches within the thread's
  workspace.

## Design

### UI Layout

```
 ┌─────────────────────────────────────────┐
 │ (context chips, if any)                 │
 │ ┌─────────────────────┐                 │
 │ │ 📄 Contract_v2.pdf  ✕│                │
 │ │ 📄 Invoice.docx     ✕│                │
 │ └─────────────────────┘                 │
 │                                         │
 │  What would you like to know?           │
 │                                         │
 │                                         │
 ├─────────────────────────────────────────┤
 │ [+ Add context]              [  Send  ] │
 └─────────────────────────────────────────┘
```

The "Add context" button sits in `PromptInputFooter`, to the
left of the submit button. It is a `Button` with `PaperclipIcon`
(or `PlusCircleIcon`) that opens a popover above the footer.

### Context Chips

Selected context items render in a horizontal flex-wrap row
above the textarea (inside the `InputGroup` but before the
textarea). Each chip shows:

- An icon (file type icon from `DocumentIcon`, folder icon)
- A truncated name (max ~20 characters)
- A close button to remove it
- For cross-workspace entities: a subtle workspace label

Chip types:

```typescript
type ContextChip =
  | {
      type: "entity";
      entityId: string;
      name: string;
      kind: string;
      mimeType: string | null;
      workspaceId: string;
      workspaceName?: string; // shown for cross-workspace
    }
  | {
      type: "file";
      file: File;
      name: string;
    };
```

### Popover Menu

The popover has three sections, each a menu item:

```
┌───────────────────────────────┐
│ 📋 From this matter           │  (only when workspaceId is set)
│ 🔍 From another matter        │
│ 📎 Upload file                 │
└───────────────────────────────┘
```

Clicking each item opens a nested view:

**"From this matter"** -- Opens an inline entity search list
(same pattern as `EntityMentionPopover` but in a popover body).
Uses the already-loaded `useWorkspaceStore` entities. Shows a
search input at the top with a filtered list below. Selecting
an entity adds it as a chip and keeps the popover open for
multi-select. The user closes the popover manually or by
clicking outside.

**"From another matter"** -- Opens a two-step flow:

1. Workspace selector: a search input filtering the workspaces
   list (from `workspacesOptions`). Shows workspace name and
   matter color.
2. Entity list: after selecting a workspace, fetches that
   workspace's entities via `entitiesOptions(selectedWsId)`
   (new query, not the store). Shows the same entity search
   list. Back button to return to workspace selector.

**"Upload file"** -- Triggers a hidden `<input type="file">`
(same pattern as `AddEntityMenu`). Selected files are added as
`file` chips. Files are not uploaded to S3 at this point; they
are held in memory as `File` objects and sent as `FileUIPart`
data URLs with the message.

### Removing @-Mention

The `MentionablePromptArea` wrapper and `EntityMentionPopover`
become unnecessary once the Add Context button is in place. The
migration path:

1. Add the new context button alongside the existing @-mention
   (both work simultaneously).
2. Once the context button is stable, remove the
   `MentionablePromptArea` wrapper and `EntityMentionPopover`.
3. The textarea becomes a plain `PromptInputTextarea` without
   the `onKeyDown` interception for `@`.

Keep this as a separate follow-up step; the initial
implementation should not break the existing @-mention flow.

## Data Flow

### How Context Reaches the Model

Two types of context require different handling:

#### Entity Context (from current or other matter)

Entity references are **not** sent as file parts. Instead, they
are sent as structured metadata alongside the message text. The
chat actor resolves entity content server-side using existing
tools (`readEntity`, `readContent`). This approach:

- Avoids sending large file blobs from the client
- Reuses the existing tool infrastructure
- Keeps content decryption server-side
- Supports workspace access validation

Implementation: when the user sends a message with entity
context chips, the frontend constructs a user message whose text
includes a structured preamble:

```
<context>
The user has attached the following entities for reference:
- [Entity Name](#stella-entity=ID1) from matter "Matter A"
- [Entity Name](#stella-entity=ID2) from matter "Matter B"
</context>

(user's actual message text)
```

The chat actor's system prompt already instructs the model to
use tools for reading entity content. The model will call
`readEntity` / `readContent` on the referenced IDs. For
cross-workspace entities, the tools need modification (see
"Cross-Workspace Access" below).

Alternative approach (preferred, cleaner): inject the entity
references as a synthetic assistant-invisible context block in
the `sendMessages` action. The chat actor receives a list of
`entityReferences` alongside the message and prepends them to
the system prompt or injects them as a tool result before the
user message. This keeps the user message clean.

**Recommended**: extend the `sendMessages` action input:

```typescript
sendMessages: (c, input: {
  threadId: string;
  chatId: string;
  message: UIMessage;
  workspaceId?: string;
  modelId?: string;
  // NEW
  contextEntities?: {
    entityId: string;
    workspaceId: string;
  }[];
}) => { ... }
```

The actor pre-fetches metadata (name, kind, workspace name) for
each referenced entity and injects it into the system prompt:

```
The user has pinned these entities for this message:
- "Contract_v2.pdf" (document) from "Acme Acquisition"
  [entity: abc123]
- "Invoice.docx" (document) from "Baker Case"
  [entity: def456]

When the user asks about these, use readEntity / readContent
with the provided entity IDs to retrieve their contents.
```

This way the model knows exactly which entities to read without
guessing, and the user's message text stays clean.

#### File Upload Context

Uploaded files are sent as `FileUIPart` in the AI SDK message.
The `sendMessage` function already supports this:

```typescript
sendMessage({
  text: "Summarize this document",
  files: [
    {
      type: "file",
      mediaType: file.type,
      filename: file.name,
      url: dataUrl, // base64 data URL
    },
  ],
});
```

On the transport layer, the `RivetChatTransport.sendMessages`
method passes the full `UIMessage` (including file parts) to
the actor. The actor's `streamText` call receives the file
content via `convertToModelMessages`, which translates
`FileUIPart` into model-level `FilePart`.

Caveat: large files as data URLs will bloat the message. Impose
a size limit (e.g., 10 MB) and show a validation error for
files exceeding it. For very large files, consider uploading to
S3 first and passing a signed URL, but defer this optimization.

### Cross-Workspace Access

Current tools (`createMatterTools`) are scoped to a single
`workspaceId`. To support cross-workspace entity context:

**Option A: Expand tool scope per message.** When
`contextEntities` contains entities from workspaces other than
the thread's primary workspace, temporarily grant the tools
access to those workspaces for the current generation. Pass an
`allowedWorkspaceIds: Set<string>` to the tool factory. The
tools check `allowedWorkspaceIds.has(entity.workspaceId)`
instead of strict equality with a single workspace.

**Option B: Pre-fetch at send time.** The chat actor
pre-fetches entity metadata and extracted content for all
referenced entities (using the existing DB queries from
`chat-tools.ts`) and injects the content directly into the
system prompt or as synthetic tool results. The model never
calls tools for these entities; the content is already there.

**Recommended: Option B for the initial implementation.** It is
simpler, avoids modifying the tool authorization model, and
works even for non-matter-scoped threads (global chat). The
pre-fetch runs once per message, bounded by the number of
context chips (cap at 5 entities per message).

Authorization for cross-workspace access: the user's session
is validated by the chat actor. Workspace access is controlled
by organization membership. Since all workspaces shown in the
picker belong to the user's organization (enforced by
`workspacesOptions` which filters by `organizationId`), the
cross-workspace read is authorized by virtue of org membership.
Additional workspace-level RBAC is a known scale gap and does
not block this feature.

Pre-fetch implementation:

```typescript
const prefetchEntityContext = async (
  refs: { entityId: string; workspaceId: string }[],
  organizationId: SafeId<"organization">,
): Promise<string> => {
  // For each ref, fetch entity name + extracted content
  // Verify workspace belongs to organization
  // Return formatted context string for system prompt
};
```

### Transport Layer Changes

The `RivetChatTransport` needs to forward `contextEntities` to
the actor. Currently, `sendMessages` on the connection sends:

```typescript
{
  (threadId, chatId, message, workspaceId, modelId);
}
```

Add `contextEntities` to this payload. The transport receives
it from the caller (the `PromptInput.onSubmit` callback in
`RightPanelChat`).

The `ChatStreamConnection` type in `rivet-transport.ts` needs
updating:

```typescript
sendMessages(input: {
  threadId: string;
  chatId: string;
  message: UIMessage;
  workspaceId?: string;
  modelId?: string;
  contextEntities?: {
    entityId: string;
    workspaceId: string;
  }[];
}): Promise<{ status: "started" | "busy" }>;
```

However, the AI SDK's `Chat.sendMessage` calls the transport's
`sendMessages` method, and there is no direct way to pass
custom data through the `ChatRequestOptions`. Two approaches:

**Approach 1: Use message metadata.** The AI SDK supports
`metadata` on messages. Store `contextEntities` in the user
message's metadata. The transport reads it from the last
message before forwarding to the actor.

**Approach 2: Side-channel via the transport instance.** Before
calling `sendMessage`, set a property on the transport instance
(e.g., `transport.pendingContext = [...]`). The transport reads
and clears this in its `sendMessages` method.

**Recommended: Approach 2.** It is simpler and does not pollute
the message format. The transport is a class instance; adding a
mutable field for per-send context is straightforward.

```typescript
class RivetChatTransport {
  // ...
  pendingContext: ContextEntity[] = [];

  sendMessages = async (options) => {
    const context = this.pendingContext;
    this.pendingContext = [];
    // Forward context to actor
  };
}
```

The `PromptInput.onSubmit` handler sets `transport.pendingContext`
before calling `sendMessage`.

## Implementation Steps

### Phase 1: Context State Management

Create a Zustand store (or a `useState` in the prompt area) for
managing the list of context chips.

**File**: `apps/web/src/components/chat-context-store.ts` (new)

```typescript
type ContextItem =
  | {
      type: "entity";
      entityId: string;
      name: string;
      kind: string;
      mimeType: string | null;
      workspaceId: string;
      workspaceName?: string;
    }
  | { type: "file"; id: string; file: File; name: string };

// State: items[], add, remove, clear
```

Alternatively, use `useState<ContextItem[]>` in the prompt
component and pass add/remove callbacks to the popover. This
is simpler and avoids a global store for ephemeral per-message
state. Prefer `useState` since context is cleared after each
send.

### Phase 2: Context Chips UI

**File**: `apps/web/src/components/ai-elements/context-chips.tsx`
(new)

Renders the list of `ContextItem` as a horizontal flex-wrap row.
Each chip:

- Shows icon + truncated name
- Has a close button (XIcon, `size-3`)
- For cross-workspace entities, shows workspace name in muted
  text
- For files, shows file size

This component slots into the `PromptInput` layout, between the
top of the `InputGroup` and the textarea.

### Phase 3: Add Context Button + Popover

**File**: `apps/web/src/components/ai-elements/add-context-popover.tsx`
(new)

Components:

- `AddContextButton` -- renders in `PromptInputFooter`
- `AddContextPopover` -- the popover with three menu items
- `EntitySearchList` -- reusable entity search list (extracted
  from `EntityMentionPopover` pattern)
- `WorkspaceEntityPicker` -- two-step workspace > entity flow

Uses coss `Popover` / `PopoverPopup` / `PopoverTrigger` from
`@stella/ui/components/popover`.

For "From this matter": uses `useWorkspaceStore` entities
(already loaded). Shows a search `Input` + filtered list.

For "From another matter": uses `useQuery(workspacesOptions)`
for workspace list, then `useQuery(entitiesOptions(wsId))` for
the selected workspace's entities.

For "Upload file": hidden `<input type="file" multiple>` with
`onChange` handler that adds `file` chips.

### Phase 4: Wire Into Prompt Submission

**Files**:

- `apps/web/src/components/right-panel-chat.tsx`
- `apps/web/src/lib/ai-sdk/rivet-transport.ts`

Update `NewChat` and `ActiveThreadInner` to:

1. Manage context state (`useState<ContextItem[]>`)
2. Render `ContextChips` above the textarea
3. Render `AddContextButton` in `PromptInputFooter`
4. On submit: set `transport.pendingContext` for entity refs,
   convert file chips to `FileUIPart` data URLs, call
   `sendMessage({ text, files })`, clear context state

Update `RivetChatTransport`:

1. Add `pendingContext` field
2. In `sendMessages`, read and clear `pendingContext`, forward
   to actor

Update `ChatStreamConnection` type to include `contextEntities`.

### Phase 5: Backend -- Pre-fetch Entity Context

**Files**:

- `apps/api/src/handlers/registry/actors/chat-actor.ts`
- `apps/api/src/handlers/registry/actors/chat-tools.ts`
  (or new file `chat-context-prefetch.ts`)

In `sendMessages` action:

1. Accept `contextEntities` in the input
2. Before calling `streamText`, pre-fetch each referenced
   entity's metadata and extracted content
3. Append the pre-fetched context to the system prompt
4. For entities from the thread's own workspace, the model can
   still use tools for follow-up questions
5. For cross-workspace entities, the injected content is all
   the model gets (tools remain workspace-scoped)

Add a helper `prefetchEntityContext` that:

- Validates each entity's workspace belongs to the org
- Fetches entity name, kind, fields via `db.query.entities`
- Fetches extracted content via `db.query.extractedContent`
  - `decryptContent`
- Truncates content to a reasonable limit (e.g., 4000 chars
  per entity, 16000 total)
- Returns a formatted string for system prompt injection

### Phase 6: Remove @-Mention (follow-up)

After the context button is stable:

1. Remove `MentionablePromptArea` wrapper
2. Remove `EntityMentionPopover` component
3. Remove `entity-mention-popover.tsx`
4. Remove `mentionable-prompt-input.tsx`
5. Update `PromptInput` usage in `right-panel-chat.tsx` to use
   plain `PromptInputTextarea` without `onKeyDown` interception
6. Remove the `chat.mention.noResults` i18n key

## i18n Keys

New keys to add to `en.json` under `chat`:

```json
{
  "chat": {
    "addContext": "Add context",
    "fromThisMatter": "From this matter",
    "fromAnotherMatter": "From another matter",
    "uploadFile": "Upload file",
    "contextEntity": "Entity from {workspace}",
    "searchEntities": "Search entities...",
    "selectMatter": "Select a matter",
    "searchMatters": "Search matters...",
    "maxContextReached": "Maximum {count} items per message",
    "fileTooLarge": "File exceeds {maxSize} limit"
  }
}
```

## Constraints and Limits

| Limit                         | Value    | Rationale               |
| ----------------------------- | -------- | ----------------------- |
| Max context items per message | 5        | Token budget            |
| Max file size (upload)        | 10 MB    | Data URL / model limits |
| Max content per entity        | 4000 ch  | Token budget            |
| Max total injected content    | 16000 ch | ~4k tokens overhead     |

These should be defined in a shared constants file, not as magic
numbers in components.

## Security Considerations

- **Cross-workspace auth**: all workspaces shown in the picker
  belong to the user's organization (enforced by
  `workspacesOptions` which queries by `organizationId`). The
  backend pre-fetch also validates org membership.
- **Entity access**: the pre-fetch verifies each entity's
  workspace belongs to the org before reading content.
- **Encrypted content**: decryption happens server-side in
  `prefetchEntityContext`, same as `readContent` tool. The
  organization-scoped encryption key is used.
- **File upload**: files are sent as data URLs in the message,
  not stored in S3. They are ephemeral (only exist for the
  model call). Malicious file content is mitigated by the
  model's own safety filters.
- **No workspace ID from client for auth**: the backend must
  verify that the referenced `workspaceId` values belong to the
  session's `organizationId`. Never trust client-supplied
  workspace IDs without validation.

## Open Questions

1. **Should entity context persist across messages in a
   thread?** Current design: context is per-message (cleared
   after send). Alternative: context chips persist until
   explicitly removed, automatically included in every message.
   Per-message is simpler and avoids token bloat on long
   conversations. Recommend per-message for v1.

2. **Should the model get raw extracted text or a summary?**
   Raw text (truncated) for v1. Summarization is a future
   optimization that would reduce token usage but adds latency
   and complexity.

3. **Should uploaded files also be saved to the matter?**
   No for v1. Uploaded files are ephemeral context for the
   model. If the user wants to save a file to the matter, they
   use the existing upload flow. This keeps the two concerns
   separate.

4. **Keyboard shortcut for "Add context"?** Consider `Cmd+K`
   or `Cmd+Shift+A` as a future enhancement. Not in v1.
