import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { createDocumentInputSchema } from "@stll/api-contract/chat-create-document";

import { compileDraftDocument, draftDocumentsOf } from "./chat-documents";

/**
 * The conversation the API recorded against the web client in which the
 * model wrote a draft with `create-document`: the stored page after each
 * step, and the continuation the web sent with the compiled draft.
 */
const recording = v.parse(
  v.looseObject({
    steps: v.array(
      v.looseObject({
        exchanges: v.array(
          v.looseObject({
            request: v.looseObject({
              forwardedProps: v.looseObject({
                message: v.looseObject({ parts: v.array(v.unknown()) }),
              }),
            }),
            page: v.looseObject({
              messages: v.array(v.looseObject({ parts: v.array(v.unknown()) })),
            }),
          }),
        ),
      }),
    ),
  }),
  JSON.parse(
    readFileSync(
      path.join(
        import.meta.dir,
        "../../../web/src/components/chat/__fixtures__/recorded-conversations/client-tool.gen.json",
      ),
      "utf-8",
    ),
  ),
);

const exchange = (step: number) => {
  const found = recording.steps[step]?.exchanges[0];
  if (found === undefined) {
    throw new Error(`The recording has no step ${String(step)}`);
  }
  return found;
};

const storedCall = v.parse(
  v.looseObject({ input: createDocumentInputSchema }),
  exchange(0).page.messages.at(-1)?.parts[0],
);

describe("a draft the model wrote", () => {
  test("compiles on the phone to the result the web sent", () => {
    const sent = v.parse(
      v.looseObject({ output: v.unknown() }),
      exchange(1).request.forwardedProps.message.parts[0],
    );
    expect(sent.output).toEqual(
      compileDraftDocument(storedCall.input, "Could not create"),
    );
  });

  test("that does not compile answers with the errors, for the model to fix", () => {
    const output = compileDraftDocument(
      { name: "Broken", source: "@unknown thing" },
      "Could not create",
    );
    expect(output.success).toBe(false);
    expect(output.success ? [] : output.errors).not.toHaveLength(0);
    expect(output.success ? "" : output.message).toBe("Could not create");
  });

  test("shows under its answer once the answer stored it, and not before", () => {
    const parts = (step: number) =>
      exchange(step).page.messages.at(-1)?.parts ?? [];
    expect(draftDocumentsOf(parts(0))).toEqual([]);
    expect(draftDocumentsOf(parts(1))).toEqual([
      {
        toolCallId: "call-1",
        fileName: "Mutual NDA.docx",
        name: storedCall.input.name,
        source: storedCall.input.source,
      },
    ]);
  });
});
