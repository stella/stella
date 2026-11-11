import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { CHAT_TITLE_SOURCE, chatThreads } from "@/api/db/schema";

/** One slot fits a bounded source lookup; larger input sets must be split. */
export const ARTEFACT_SOURCE_DECISION_LIMIT = 1024;
export const generatedOrigin = v.strictObject({
  type: v.literal("generated"),
  generator: v.pipe(v.string(), v.minLength(1)),
  decisionIds: v.pipe(
    v.array(v.pipe(v.string(), v.uuid())),
    v.maxLength(ARTEFACT_SOURCE_DECISION_LIMIT),
  ),
  coverage: v.picklist(["complete", "legacy-input"]),
});
const authoredOrigin = v.strictObject({ type: v.literal("authored") });
const storedOrigin = v.variant("type", [generatedOrigin, authoredOrigin]);
const storedProvenance = v.strictObject({
  version: v.literal(1),
  slots: v.pipe(
    v.unknown(),
    v.check(
      (slots) => !Array.isArray(slots),
      "Provenance slots must be an object",
    ),
    v.record(v.pipe(v.string(), v.minLength(1)), storedOrigin),
  ),
});
export type StoredArtefactProvenance = v.InferOutput<typeof storedProvenance>;
export type ArtefactOrigin =
  v.InferOutput<typeof storedOrigin> | { type: "legacy" };
export type GeneratedOrigin = v.InferOutput<typeof generatedOrigin>;
export const readArtefactOrigin = (
  provenance: unknown,
  slot: string,
): ArtefactOrigin => {
  if (provenance === null || provenance === undefined) {
    return { type: "legacy" };
  }
  const parsed = v.safeParse(storedProvenance, provenance);
  if (!parsed.success) {
    return panic("Invalid stored artefact provenance");
  }
  return (
    new Map(Object.entries(parsed.output.slots)).get(slot) ?? { type: "legacy" }
  );
};

/** A deterministic fork inherits only the value it actually copies. */
export const copyThreadArtefactTitle = (
  row: Pick<
    typeof chatThreads.$inferSelect,
    "title" | "titleSource" | "generationProvenance"
  >,
) => {
  const origin =
    row.titleSource === CHAT_TITLE_SOURCE.USER
      ? ({ type: "authored" } as const)
      : readArtefactOrigin(row.generationProvenance, "title");
  return {
    title: row.title,
    titleSource: row.titleSource,
    generationProvenance:
      origin.type === "legacy"
        ? null
        : ({
            version: 1,
            slots: { title: origin },
          } satisfies StoredArtefactProvenance),
  };
};

/** Preserve the provenance column when a reader rebuilds a complete thread row. */
export const projectThreadArtefactProvenance = (
  row: Pick<typeof chatThreads.$inferSelect, "generationProvenance">,
) => ({ generationProvenance: row.generationProvenance });

export const THREAD_ARTEFACT_PROVENANCE_SELECTION = Object.freeze({
  generationProvenance: chatThreads.generationProvenance,
} as const);

export const THREAD_ARTEFACT_PROVENANCE_COLUMNS = Object.freeze({
  generationProvenance: true,
} as const);

export class ArtefactProvenanceDecodeError extends TaggedError(
  "ArtefactProvenanceDecodeError",
)<{
  message: string;
}> {}

/** Raw SQL records must satisfy the same persisted contract as typed rows. */
export const decodeRawThreadArtefactProvenance = (row: {
  generation_provenance: unknown;
}) => {
  if (row.generation_provenance === null) {
    return Result.ok(
      projectThreadArtefactProvenance({ generationProvenance: null }),
    );
  }
  const parsed = v.safeParse(storedProvenance, row.generation_provenance);
  if (!parsed.success) {
    return Result.err(
      new ArtefactProvenanceDecodeError({
        message: "Invalid stored artefact provenance",
      }),
    );
  }
  return Result.ok(
    projectThreadArtefactProvenance({ generationProvenance: parsed.output }),
  );
};
