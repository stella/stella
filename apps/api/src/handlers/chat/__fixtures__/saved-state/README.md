# Saved chat state from earlier releases

Each JSON file holds the rows one version of the API stored for the same
scripted conversation (`writeSavedStateConversation` in
`apps/api/src/tests/helpers/chat-saved-state.ts`): a text answer, a server
tool, an approved call, a denied call, a provider failure, and an approval the
thread is still waiting on. The rows are `to_jsonb` of `chat_threads`,
`chat_messages`, `chat_turns` and `chat_thread_names`, exactly as that code
wrote them. `sourceCommit` is the commit whose code wrote them; `release` is
its release tag, or null for unreleased main.

`saved-state-compat.integration.test.ts` loads every file into the current
schema, runs the chat data migrations the file predates
(`CHAT_DATA_MIGRATIONS`), and drives the thread with the web app's chat
runtime: reload, answer the waiting approval (approve, and separately deny), a
follow-up, and a retry. Every harness oracle runs after each step, and
`chat.persisted.past-release-loads` fails when anything the file stored is no
longer served or stored.

`storedDefects` lists what a release itself stored wrongly (for example an
approved call its continuation never closed). The harness must report exactly
those on the loaded thread, and continuing the thread must add nothing to
them.

The older files were written by backporting the writer into a checkout of the
release and sending requests the way today's web client builds them.

## When the stored shape changes

The test `cover the shape the current code stores` compares the shape of what
the current code writes (columns, content envelopes, part and tool-call
states, turn rows, thread-name kinds) with every file here. When it fails:

1. Keep every existing file. Each is a shape some deployment may still hold.
2. Run `bun run gen:chat-saved-state` in `apps/api`. It writes
   `main-<date>.json` from the current code.
3. If the change ships a migration that rewrites stored chat rows, add it to
   `CHAT_DATA_MIGRATIONS`; the test fails until you do. A listed migration is
   replayed whole (without its `SET` lines), so keep it data-only.
4. Run the test. A file that no longer loads or continues is a compat break to
   fix in the reader, not a file to regenerate.

Once a release ships, you may rename a `main-*` file after it and set its
`release`. Files contain only test data from the scripted conversation.

`main-2026-10-07-reattach.json` also stores native interrupt resume state on
awaiting-user assistant messages. That state restores approvals after reload
and after the delivery log expires.
