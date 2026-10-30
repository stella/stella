import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { chatThreads } from "@/api/db/schema";
import { createMockDatabase } from "@/api/db/sql-client";
import { toSafeId } from "@/api/lib/branded-types";
import { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";

import type { ArtefactOrigin } from "./generated-artefact-provenance";
import {
  authorArtefact,
  copyThreadArtefactTitle,
  generateArtefact,
  projectArtefactText,
  projectThreadArtefactProvenance,
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
    { version: 1, slots: [] },
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

test("thread copies retain the title origin without copying other slots", () => {
  const title = {
    type: "generated",
    generator,
    decisionIds: [first],
    coverage: "complete",
  } as const;
  const source = {
    title: text,
    titleSource: "ai" as const,
    generationProvenance: {
      version: 1 as const,
      slots: {
        title: { ...title, decisionIds: [...title.decisionIds] },
        recap: { type: "authored" as const },
      },
    },
  };
  expect(copyThreadArtefactTitle(source)).toEqual({
    title: text,
    titleSource: "ai",
    generationProvenance: { version: 1, slots: { title } },
  });
  const authored = copyThreadArtefactTitle({ ...source, titleSource: "user" });
  expect(readArtefactOrigin(authored.generationProvenance, "title")).toEqual({
    type: "authored",
  });
  expect(
    copyThreadArtefactTitle({ ...source, generationProvenance: null })
      .generationProvenance,
  ).toBeNull();
});

test("provenance projection forwards stored rows rather than accepting bare values", () => {
  const row = { generationProvenance: null };
  expect(projectThreadArtefactProvenance(row)).toEqual(row);
  // @ts-expect-error -- only a stored row can be forwarded; a bare value cannot construct provenance.
  projectThreadArtefactProvenance("untrusted");
});

test("provenance selection constants are immutable and cannot manufacture stored metadata", async () => {
  const {
    THREAD_ARTEFACT_PROVENANCE_SELECTION,
    THREAD_ARTEFACT_PROVENANCE_COLUMNS,
  } = await import("./generated-artefact-provenance");
  expect(Object.keys(THREAD_ARTEFACT_PROVENANCE_SELECTION)).toEqual([
    "generationProvenance",
  ]);
  expect(THREAD_ARTEFACT_PROVENANCE_SELECTION.generationProvenance).toBe(
    chatThreads.generationProvenance,
  );
  expect(THREAD_ARTEFACT_PROVENANCE_COLUMNS).toEqual({
    generationProvenance: true,
  });
  expect(Object.isFrozen(THREAD_ARTEFACT_PROVENANCE_SELECTION)).toBe(true);
  expect(Object.isFrozen(THREAD_ARTEFACT_PROVENANCE_COLUMNS)).toBe(true);
  const db = createMockDatabase();
  const selectionUpdate = db
    .update(chatThreads)
    .set({ ...THREAD_ARTEFACT_PROVENANCE_SELECTION })
    .where(sql`false`)
    .toSQL();
  expect(selectionUpdate.sql).toContain(
    '"generation_provenance" = "chat_threads"."generation_provenance"',
  );
  expect(selectionUpdate.sql).not.toMatch(/"generation_provenance" = \$/u);
  db.update(chatThreads)
    // @ts-expect-error -- relational column selection cannot be persisted as provenance.
    .set({ ...THREAD_ARTEFACT_PROVENANCE_COLUMNS })
    .where(sql`false`)
    .toSQL();
});

test("raw provenance decoding accepts only null or validated stored records", async () => {
  const { decodeRawThreadArtefactProvenance } =
    await import("./generated-artefact-provenance");
  const record = {
    version: 1,
    slots: {
      title: {
        type: "generated",
        generator,
        decisionIds: [first],
        coverage: "complete",
      },
      recap: { type: "authored" },
    },
  };
  for (const value of [null, record]) {
    const decoded = decodeRawThreadArtefactProvenance({
      generation_provenance: value,
    });
    expect(decoded.isOk()).toBe(true);
    expect(decoded.unwrap()).toEqual({ generationProvenance: value });
  }
});

test("raw provenance decoding rejects absent fields and malformed metadata with a typed error", async () => {
  const { decodeRawThreadArtefactProvenance, ArtefactProvenanceDecodeError } =
    await import("./generated-artefact-provenance");
  for (const value of [
    undefined,
    {},
    [],
    1,
    true,
    "null",
    "{invalid json",
    '{"version":1,"slots":{}}',
    { version: 2, slots: {} },
    { version: 1, slots: { title: {} } },
    { version: 1, slots: [] },
  ]) {
    const decoded = decodeRawThreadArtefactProvenance({
      generation_provenance: value,
    });
    expect(decoded.isErr(), JSON.stringify(value)).toBe(true);
    if (decoded.isErr()) {
      expect(decoded.error).toBeInstanceOf(ArtefactProvenanceDecodeError);
    }
  }
  // @ts-expect-error -- raw query consumers must select the required database column.
  const missing = decodeRawThreadArtefactProvenance({});
  expect(missing.isErr()).toBe(true);
  if (missing.isErr()) {
    expect(missing.error).toBeInstanceOf(ArtefactProvenanceDecodeError);
  }
});
