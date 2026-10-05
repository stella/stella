import { Panic, UnhandledException } from "better-result";
import { expect, test } from "bun:test";

import { createAutocompleteEventStream } from "@/api/handlers/ai-autocomplete/stream";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const MARKER = "SENTINEL_FOREIGN_TEXT";
const failures = {
  Panic: new Panic({ message: MARKER }),
  UnhandledException: new UnhandledException({ cause: new Error(MARKER) }),
  HandlerError: new HandlerError({ status: 503, message: "Request refused" }),
};

for (const [label, error] of Object.entries(failures)) {
  test(`autocomplete events select the approved message for ${label}`, async () => {
    if (!(error instanceof HandlerError)) {
      expect(error.message).toContain(MARKER);
    }
    const stream = createAutocompleteEventStream(
      (async function* () {
        yield "Continuation";
        throw error;
      })(),
      new AbortController().signal,
    );
    const events = await new Response(stream).text();
    expect(events).toContain('event: token\ndata: {"text":"Continuation"}');
    expect(events).toContain(
      `event: error\ndata: ${JSON.stringify({
        message:
          error instanceof HandlerError ? error.message : "stream interrupted",
      })}`,
    );
    expect(events).not.toContain(MARKER);
    expect(events).not.toContain("event: done");
  });
}
