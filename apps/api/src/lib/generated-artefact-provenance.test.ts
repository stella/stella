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
      expect(context.snapshot().unwrap()).toEqual({
        type: "generated",
        generator,
        decisionIds: [first, second],
        coverage: "legacy-input",
      });
      const snapshot = context.snapshot().unwrap();
      snapshot.decisionIds.length = 0;
      return text;
    },
  });
  pending.resolve(undefined);
  expect(
    projectArtefactText({ artefact: (await result).unwrap(), projection }),
  ).toBe("Unavailable");
});

test("authored, recorded empty and legacy values remain readable", async () => {
  const generated = (
    await generateArtefact({
      generator,
      sources: { decisionIds: [], inputs: [] },
      generate: () => text,
    })
  ).unwrap();
  for (const artefact of [generated, authorArtefact(text)]) {
    expect(projectArtefactText({ artefact, projection })).toBe(text);
  }
  for (const metadata of [null, undefined, { version: 1, slots: {} }]) {
    const origin = readArtefactOrigin(metadata, "title");
    expect(origin).toEqual({ type: "legacy" });
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(readArtefactOrigin(metadata, key)).toEqual({ type: "legacy" });
    }
    expect(readArtefactText({ value: text, origin, projection })).toBe(text);
  }
});

test("source unions are invariant under duplicates and input order", async () => {
  for (const ids of [
    [],
    [first],
    [first, first],
    [second, first],
    [first, second],
  ]) {
    const inherited = {
      type: "generated",
      generator,
      decisionIds: [second],
      coverage: "complete",
    } satisfies ArtefactOrigin;
    const artefact = (
      await generateArtefact({
        generator,
        sources: { decisionIds: ids, inputs: [inherited] },
        generate: () => text,
      })
    ).unwrap();
    expect(
      projectArtefactText({
        artefact,
        projection: new WithdrawnCopyProjection([second], "Unavailable"),
      }),
    ).toBe("Unavailable");
    expect(projectArtefactText({ artefact, projection })).toBe(
      ids.includes(first) ? "Unavailable" : text,
    );
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

test.each(["direct", "inherited"])(
  "%s source overflow returns a tagged error before dispatch",
  async (input) => {
    const { ARTEFACT_SOURCE_DECISION_LIMIT, ArtefactSourceLimitError } =
      await import("./generated-artefact-provenance");
    let dispatched = false;
    const decisionIds = Array.from(
      { length: ARTEFACT_SOURCE_DECISION_LIMIT + 1 },
      (_, index) =>
        toSafeId<"caseLawDecision">(
          `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        ),
    );
    const result = await generateArtefact({
      generator,
      sources:
        input === "direct"
          ? { decisionIds, inputs: [] }
          : {
              decisionIds: [],
              inputs: [
                {
                  type: "generated",
                  generator,
                  decisionIds,
                  coverage: "complete",
                },
              ],
            },
      generate: () => {
        dispatched = true;
        return text;
      },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ArtefactSourceLimitError);
    }
    expect(dispatched).toBe(false);
  },
);

test("an ignored tool source overflow prevents publishing an artefact", async () => {
  const { ARTEFACT_SOURCE_DECISION_LIMIT, ArtefactSourceLimitError } =
    await import("./generated-artefact-provenance");
  const decisionIds = Array.from(
    { length: ARTEFACT_SOURCE_DECISION_LIMIT },
    (_, index) =>
      toSafeId<"caseLawDecision">(
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      ),
  );
  expect(
    (
      await generateArtefact({
        generator,
        sources: { decisionIds, inputs: [] },
        generate: () => text,
      })
    ).isOk(),
  ).toBe(true);
  let dispatched = false;
  const result = await generateArtefact({
    generator,
    sources: { decisionIds: [first], inputs: [] },
    generate: (context) => {
      dispatched = true;
      expect(context.include({ decisionIds, inputs: [] }).isErr()).toBe(true);
      expect(context.include({ decisionIds: [], inputs: [] }).isErr()).toBe(
        true,
      );
      expect(context.snapshot().isErr()).toBe(true);
      return text;
    },
  });
  expect(dispatched).toBe(true);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(ArtefactSourceLimitError);
  }
});
