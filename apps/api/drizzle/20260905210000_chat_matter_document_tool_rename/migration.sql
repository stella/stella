SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint

-- The native chat tool `create_workspace_document` is now
-- `create_matter_document`, with no alias: `validateMessage`
-- (apps/api/src/handlers/chat/chat-schema.ts) looks the part's `name` up in the
-- tool map and rejects a miss with "Unknown chat tool". A thread that was
-- persisted mid-approval before this deploy therefore reloads into a 400 for
-- the rest of its life unless the stored name moves with the code.
--
-- Rows touched: `chat_messages` whose `content->'data'` array holds a part with
-- `type = 'tool-call'` and `name = 'create_workspace_document'` -- an assistant
-- message carrying that tool call in any state (`approval-requested` is the one
-- that blocks a live thread; `complete`/`error` history is rewritten too, so a
-- reload of an old thread validates the same way). Every persisted content
-- version keeps its parts under the same `data` array (v1 `LegacyChatMessageContent`,
-- v2 `ChatMessageContent`, v3 `PersistedChatMessageContentV3`), so one
-- statement covers all three; `jsonb_set` on `{data}` leaves `version` and
-- `metadata` untouched.
--
-- No other table stores a chat tool NAME: `chat_turns` keys an in-flight
-- interaction by `interaction_tool_call_id` (an id) and `interaction_type` (an
-- enum), and `chat_thread_compactions.summary` is prose.
--
-- Idempotent: the containment predicate stops matching once a row is rewritten,
-- so a re-run is a no-op, and it is also the statement's bound -- `chat_messages`
-- scales with workspaces, not with the legal corpus, and is not registered in
-- `high-volume-tables.ts`.
UPDATE chat_messages
SET content = jsonb_set(
    content,
    '{data}',
    (
      SELECT jsonb_agg(
          CASE
            WHEN part->>'type' = 'tool-call'
              AND part->>'name' = 'create_workspace_document'
            THEN jsonb_set(part, '{name}', '"create_matter_document"'::jsonb)
            ELSE part
          END
          ORDER BY position
        )
      FROM jsonb_array_elements(content->'data')
        WITH ORDINALITY AS element(part, position)
    )
  )
WHERE jsonb_typeof(content->'data') = 'array'
  AND content->'data' @> '[{"type": "tool-call", "name": "create_workspace_document"}]'::jsonb;
