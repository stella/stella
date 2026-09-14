# Provider cassettes

These are sanitized recordings of synthetic provider probes, not user traffic.
Replay tests run through the real SDK and application generation code, offline.
They complement the production-tool schema matrix and weekly live canary; a past
response cannot prove that a provider still accepts a request today.

The initial probe covers OpenRouter text streaming. The transport supports JSON
and SSE, not binary AWS event streams. Do not treat it as recorded coverage of all
providers or of document edits.

From `apps/api`, replay with no credentials or model charges:

```sh
bun run canary:ai-provider:cassette replay scripts/fixtures/ai-provider-cassettes/openrouter-ok.json
```

To refresh after an intentional request, model, or adapter change, explicitly
record to a new path, using `AI_CANARY_API_KEY` supplied by the environment:

```sh
bun run canary:ai-provider:cassette record scripts/fixtures/ai-provider-cassettes/openrouter-ok.next.json
```

Recording makes at most one HTTP request, with a 32-output-token limit and no
retry. It refuses to overwrite a file. Review the new cassette, replay it, then
replace the previous fixture in the same change. Never automatically re-record
on a CI mismatch. Never pass production conversations or documents to a recorder.

Request matching includes the endpoint, selected protocol headers, and a hash of
the canonical JSON body. Changing prompts, schemas, model IDs, or generation
options invalidates the recording; JSON key ordering does not. Authentication
headers and prompt bodies are not stored. Response usage fields are retained;
request identifiers are sanitized, while tool-call IDs remain for protocol
continuations. Missing, extra, changed, or unconsumed requests fail replay without
falling back to the network.

The nightly suite replays committed fixtures. The weekly live canary remains
independent: it neither approves nor replaces recordings automatically.
