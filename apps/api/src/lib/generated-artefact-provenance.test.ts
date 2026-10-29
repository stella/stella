import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";

import type { ArtefactOrigin } from "./generated-artefact-provenance";
import {
  authorArtefact,
  generateArtefact,
  projectArtefactText,
  readArtefactOrigin,
  readArtefactText,
} from "./generated-artefact-provenance";

const first = toSafeId<"caseLawDecision">(
  "abcdef01-0000-4000-8000-000000000001",
);
const second = toSafeId<"caseLawDecision">(
  "abcdef01-0000-4000-8000-000000000002",
);
const generator = "apps/api/src/handlers/chat/generate-thread-title.ts";
const projection = new WithdrawnCopyProjection([first], "Unavailable");
const text = "An answer without a citation";

test("generation captures input identities before dispatch and unions later tool inputs", async () => {
  const ids = [first];
  const pending = Promise.withResolvers<undefined>();
  const result = generateArtefact({
    generator,
    sources: { decisionIds: ids, inputs: [] },
    generate: async (context) => {
      ids.length = 0;
      await pending.promise;
      context.include({
        decisionIds: [second, first],
        inputs: [{ type: "legacy" }],
      });
      expect(context.snapshot()).toEqual({
        type: "generated",
        generator,
        decisionIds: [first, second],
        coverage: "legacy-input",
      });
      const snapshot = context.snapshot();
      snapshot.decisionIds.length = 0;
      return text;
    },
  });
  pending.resolve(undefined);
  expect(projectArtefactText({ artefact: await result, projection })).toBe(
    "Unavailable",
  );
});

test("authored, recorded empty and legacy values remain readable", async () => {
  const generated = await generateArtefact({
    generator,
    sources: { decisionIds: [], inputs: [] },
    generate: () => text,
  });
  for (const artefact of [generated, authorArtefact(text)]) {
    expect(projectArtefactText({ artefact, projection })).toBe(text);
  }
  for (const metadata of [null, undefined, { version: 1, slots: {} }]) {
    const origin = readArtefactOrigin(metadata, "title");
    expect(origin).toEqual({ type: "legacy" });
    expect(readArtefactText({ value: text, origin, projection })).toBe(text);
  }
});

test("source unions are invariant under duplicates and input order", async () => {
  for (const ids of [
    [first, second],
    [second, first],
    [first, first, second],
    [second, second, first],
  ]) {
    for (const decision of [first, second]) {
      const inherited = {
        type: "generated",
        generator,
        decisionIds: [decision],
        coverage: "complete",
      } satisfies ArtefactOrigin;
      const artefact = await generateArtefact({
        generator,
        sources: { decisionIds: ids, inputs: [inherited] },
        generate: () => text,
      });
      expect(
        projectArtefactText({
          artefact,
          projection: new WithdrawnCopyProjection([decision], "Unavailable"),
        }),
      ).toBe("Unavailable");
    }
  }
});

test("stored provenance rejects invalid recorded states instead of treating them as legacy", () => {
  for (const metadata of [
    { version: 2, slots: {} },
    { version: 1, slots: { title: {} } },
    {
      version: 1,
      slots: {
        title: {
          type: "generated",
          generator,
          decisionIds: [],
          coverage: "unknown",
        },
      },
    },
    {
      version: 1,
      slots: {
        title: {
          type: "generated",
          generator,
          decisionIds: ["invalid"],
          coverage: "complete",
        },
      },
    },
  ]) {
    expect(() => readArtefactOrigin(metadata, "title")).toThrow(
      "Invalid stored artefact provenance",
    );
  }
});

test("source overflow fails before generation instead of truncating sources", async () => {
  const { ARTEFACT_SOURCE_DECISION_LIMIT, ArtefactSourceLimitError } =
    await import("./generated-artefact-provenance");
  const { rejectionOf } = await import("@stll/property-testing/rejection");
  let dispatched = false;
  const decisionIds = Array.from(
    { length: ARTEFACT_SOURCE_DECISION_LIMIT + 1 },
    (_, index) =>
      toSafeId<"caseLawDecision">(
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      ),
  );
  const error = await rejectionOf(
    generateArtefact({
      generator,
      sources: { decisionIds, inputs: [] },
      generate: () => {
        dispatched = true;
        return text;
      },
    }),
  );
  expect(error).toBeInstanceOf(ArtefactSourceLimitError);
  expect(dispatched).toBe(false);
});
