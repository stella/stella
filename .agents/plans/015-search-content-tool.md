# 015: Content Search Tool for AI Chat

## Problem

The chat's `searchMatter` tool finds entities by name/headline
via FTS, and `readContent` reads a single document's full text.
There is no tool that searches _across_ document text content
within a matter and returns relevant passages. The AI must
currently search, then read each document individually, wasting
tool steps and tokens.

## Goal

Add a `searchContent` tool that searches across extracted
document text within the current matter and returns matching
passages (chunks) with document metadata. This bridges the gap
between "find a document" (searchMatter) and "read a document"
(readContent).

## Research Summary

A survey of content-search tools across major AI assistants
(Gemini CLI, Cursor, Claude Code, Continue, Cody, OpenAI,
LangChain, LlamaIndex) reveals two broad patterns:

### Line-oriented (code tools)

Used by: Gemini CLI, Cursor grep, Claude Code, Continue.
Returns `File: path` + `L<num>: content` grouped by file.
Best for code where line numbers matter. All use ripgrep
or git grep under the hood.

### Chunk-oriented (document tools)

Used by: OpenAI file_search, Cody, LangChain, LlamaIndex.
Returns passages/chunks with file metadata and optional
relevance scores. Better for natural-language documents
where the unit is a passage, not a line.

### Key patterns

| Pattern       | Consensus                                                                            |
| ------------- | ------------------------------------------------------------------------------------ |
| Input         | Single `query` string (required) + optional filters                                  |
| Result cap    | 10-100 matches; total output under ~2,000 tokens                                     |
| Truncation    | Append warning when results are capped                                               |
| Search method | Code tools: keyword/regex. Doc tools: semantic or hybrid                             |
| Auto-context  | Gemini enriches low-match results with surrounding lines (10% fewer follow-up reads) |

### Implication for Stella

Stella's use case is document content (PDFs, DOCX), not code.
Chunk-oriented results are the right fit. Start with keyword
search (PostgreSQL FTS on `search_documents.searchable_text`),
which is already indexed. Hybrid/semantic search can be added
later without changing the tool schema.

## Design

### Tool: `searchContent`

```typescript
searchContent: tool({
  description:
    "Search across document text content within the " +
    "current matter. Returns matching passages with " +
    "document name and entity ID. Use this to find " +
    "specific clauses, terms, or information across " +
    "all documents without reading each one.",
  inputSchema: z.object({
    query: z
      .string()
      .max(LIMITS.searchQueryMaxLength)
      .describe("Text or keywords to search for"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe("Max results (default: 5)"),
  }),
});
```

### How it works

1. Run `plainto_tsquery` against `search_documents` scoped
   to the workspace (same FTS infrastructure as `searchMatter`)
2. For each hit, use `ts_headline` with a larger `MaxWords`
   window (60-80 words) to extract a meaningful passage
3. Return results as chunk-oriented objects:
   ```json
   {
     "results": [
       {
         "entityId": "abc123",
         "name": "Employment Agreement - Smith.pdf",
         "kind": "document",
         "passage": "...the Employee shall not, during the
           term of employment or for a period of two (2)
           years thereafter, engage in any business..."
       }
     ],
     "totalCount": 42,
     "truncated": true
   }
   ```
4. Cap at 5 results by default to keep token usage low
   (each passage ~100-150 tokens, total ~500-750 tokens)
5. Strip HTML highlight markers; the AI reads plain text

### Differences from `searchMatter`

|               | searchMatter               | searchContent              |
| ------------- | -------------------------- | -------------------------- |
| Purpose       | Find entities by name      | Find text in documents     |
| Headline      | Short (15-35 words)        | Long passage (60-80 words) |
| Returns       | Entity list with metadata  | Passages with entity refs  |
| Default limit | 10                         | 5 (passages are larger)    |
| Use case      | "What documents are here?" | "Which doc mentions X?"    |

### System prompt update

Add `searchContent` to the tool list in the system prompt
instructions so the AI knows when to use it vs `searchMatter`.

## Implementation

### Phase 1: Unify tool architecture + add searchContent

Refactored the 4-way tool branching into 2 layers:

1. **Org tools** (`createOrgTools`) — always available:
   `searchAcrossMatters`, `readContentAcrossMatters`,
   `readContact`, `listTemplates`, `readClause`
2. **Matter tools** (`createMatterTools`) — available when
   workspace IDs are known (bound or mentioned):
   `searchMatter`, `searchContent`, `listEntities`,
   `readEntity`, `readContent`

Eliminated:

- `createCrossMatterTools` (merged into `createOrgTools`)
- Old single-workspace `createMatterTools` (merged into
  the multi-workspace variant, always explicit `workspaceId`)
- The "no tools" global chat case (org tools always on)
- Separate `MESSAGE_WINDOW` for tool vs no-tool threads

All matter tools now take an explicit `workspaceId` param,
validated against an allowed set. Single-workspace threads
pass `allowedWorkspaceIds: [boundWsId]`.

### Phase 2: (future) Hybrid search

When vector embeddings are added, upgrade to hybrid
(keyword + semantic) without changing the tool interface.
Follow OpenAI's pattern of configurable weight between
keyword and embedding scores.

## Out of Scope

- Semantic/vector search (future)
- Cross-workspace content search (requires different auth)
- Regex pattern matching (FTS keywords are sufficient)
- Frontend changes (tool results render via existing cards)
