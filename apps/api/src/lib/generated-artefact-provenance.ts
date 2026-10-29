import { panic, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { CHAT_TITLE_SOURCE, chatThreads } from "@/api/db/schema";
import type { ChatTitleSource } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { WithdrawnCopyProjection } from "@/api/lib/case-law/withdrawn-copy-projection";
import type { ModelOperationId } from "@/api/lib/model-operation-registry";

/** One slot fits a bounded source lookup; larger input sets must be split. */
export const ARTEFACT_SOURCE_DECISION_LIMIT = 1024;
export class ArtefactSourceLimitError extends TaggedError(
  "ArtefactSourceLimitError",
)<{ message: string }> {}

const generatedOrigin = v.strictObject({
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
  slots: v.record(v.pipe(v.string(), v.minLength(1)), storedOrigin),
});
export type StoredArtefactProvenance = v.InferOutput<typeof storedProvenance>;
export type ArtefactOrigin =
  v.InferOutput<typeof storedOrigin> | { type: "legacy" };
type GeneratedOrigin = v.InferOutput<typeof generatedOrigin>;
type ArtefactSources = {
  decisionIds: readonly SafeId<"caseLawDecision">[];
  inputs: readonly ArtefactOrigin[];
};

/** Sources are captured before dispatch, and tools may extend the same context. */
class GenerationContext {
  readonly #decisions = new Set<string>();
  #coverage: GeneratedOrigin["coverage"] = "complete";
  readonly generator: ModelOperationId;
  constructor(generator: ModelOperationId, sources: ArtefactSources) {
    this.generator = generator;
    this.include(sources);
  }
  include({ decisionIds, inputs }: ArtefactSources): void {
    for (const id of decisionIds) {
      this.#addDecision(id);
    }
    for (const input of inputs) {
      switch (input.type) {
        case "authored":
          break;
        case "legacy":
          this.#coverage = "legacy-input";
          break;
        case "generated":
          for (const id of input.decisionIds) {
            this.#addDecision(id);
          }
          if (input.coverage === "legacy-input") {
            this.#coverage = "legacy-input";
          }
          break;
        default:
          input satisfies never;
          panic("Unhandled artefact input origin");
      }
    }
    this.snapshot();
  }
  #addDecision(id: string): void {
    this.#decisions.add(id.toLowerCase());
    if (this.#decisions.size > ARTEFACT_SOURCE_DECISION_LIMIT) {
      throw new ArtefactSourceLimitError({
        message: "Generated artefact provenance exceeds its decision limit",
      });
    }
  }
  snapshot(): GeneratedOrigin {
    const parsed = v.safeParse(generatedOrigin, {
      type: "generated",
      generator: this.generator,
      decisionIds: [...this.#decisions].toSorted(),
      coverage: this.#coverage,
    });
    if (!parsed.success) {
      return panic("Invalid generated artefact source identity");
    }
    return parsed.output;
  }
}

const readValue = Symbol("readArtefactValue");
class Artefact<T> {
  readonly #value: T;
  readonly #origin: Exclude<ArtefactOrigin, { type: "legacy" }>;
  constructor(value: T, origin: Exclude<ArtefactOrigin, { type: "legacy" }>) {
    this.#value = value;
    this.#origin = origin;
  }
  [readValue]() {
    return { value: this.#value, origin: this.#origin };
  }
}
export type ArtefactValue<T> = Artefact<T>;

type GenerateArtefactOptions<T> = {
  generator: ModelOperationId;
  sources: ArtefactSources;
  generate: (context: GenerationContext) => T | Promise<T>;
};

/** No defaults: even a model with no decision inputs states an explicit set. */
export const generateArtefact = async <T>({
  generator,
  sources,
  generate,
}: GenerateArtefactOptions<T>): Promise<ArtefactValue<T>> => {
  const context = new GenerationContext(generator, sources);
  const value = await generate(context);
  return new Artefact(value, context.snapshot());
};

export const authorArtefact = <T>(value: T): ArtefactValue<T> =>
  new Artefact(value, { type: "authored" });

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

type ReadArtefactTextOptions = {
  value: string;
  origin: ArtefactOrigin;
  projection: WithdrawnCopyProjection;
};
/** Status and localized markers belong to the existing withdrawn-copy owner. */
export const readArtefactText = ({
  value,
  origin,
  projection,
}: ReadArtefactTextOptions): string => {
  switch (origin.type) {
    case "legacy":
    case "authored":
      return value;
    case "generated":
      return projection.marker({ decisionIds: origin.decisionIds }) ?? value;
    default:
      origin satisfies never;
      return panic("Unhandled artefact read origin");
  }
};

type ProjectArtefactTextOptions = {
  artefact: ArtefactValue<string>;
  projection: WithdrawnCopyProjection;
};
export const projectArtefactText = ({
  artefact,
  projection,
}: ProjectArtefactTextOptions): string =>
  readArtefactText({ ...artefact[readValue](), projection });

type WriteThreadArtefactTitleOptions = {
  tx: Transaction;
  threadId: SafeId<"chatThread">;
  expected: { title: string; source: ChatTitleSource };
  recordAuditEvent: AuditRecorder;
  artefact: ArtefactValue<string>;
};
/** Value, origin and the title's ownership discriminator change atomically. */
export const writeThreadArtefactTitle = async ({
  tx,
  threadId,
  expected,
  recordAuditEvent,
  artefact,
}: WriteThreadArtefactTitleOptions): Promise<boolean> => {
  const { value, origin } = artefact[readValue]();
  const generated = origin.type === "generated";
  const updated = await tx
    .update(chatThreads)
    .set({
      title: value,
      titleSource: generated ? CHAT_TITLE_SOURCE.AI : CHAT_TITLE_SOURCE.USER,
      generationProvenance: sql`jsonb_set(coalesce(nullif(${chatThreads.generationProvenance}, 'null'::jsonb), '{"version":1,"slots":{}}'::jsonb), '{slots,title}', ${JSON.stringify(origin)}::text::jsonb, true)`,
    })
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.title, expected.title),
        eq(chatThreads.titleSource, expected.source),
        generated
          ? eq(chatThreads.titleSource, CHAT_TITLE_SOURCE.DEFAULT)
          : undefined,
      ),
    )
    .returning({ id: chatThreads.id, workspaceId: chatThreads.workspaceId });
  const row = updated.at(0);
  if (row === undefined) {
    return false;
  }
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: row.id,
    workspaceId: row.workspaceId,
    changes: {
      titleChanged: { old: false, new: true },
      titleSource: {
        old: expected.source,
        new: generated ? CHAT_TITLE_SOURCE.AI : CHAT_TITLE_SOURCE.USER,
      },
    },
  });
  return true;
};
