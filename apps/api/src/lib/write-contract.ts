import { panic } from "better-result";

import { HandlerError } from "./errors/tagged-errors";
import {
  isValibotSchema,
  toRouteJsonSchema,
} from "./json-schema/valibot-to-json-schema";
import {
  assertUnchangedSince,
  VERSION_CONFLICT_ERROR_CODE,
} from "./optimistic-concurrency";
import { isRecord, isUnknownArray } from "./type-guards";

/** Exact migration identities; the route census binds these to the reasoned baseline. */
const REPLACE_CONTRACT_DEBT_IDS = [
  "apps/api/src/handlers/case-law/research/columns-reorder.ts",
  "apps/api/src/handlers/chat/messages/revisions/accept.ts",
  "apps/api/src/handlers/clauses/update.ts",
  "apps/api/src/handlers/clauses/variants/update.ts",
  "apps/api/src/handlers/contacts/update.ts",
  "apps/api/src/handlers/document-types/reorder.ts",
  "apps/api/src/handlers/entities/versions/upload.ts",
  "apps/api/src/handlers/entity-views/reorder.ts",
  "apps/api/src/handlers/entity-views/update.ts",
  "apps/api/src/handlers/fields/upsert.ts",
  "apps/api/src/handlers/flows/update.ts",
  "apps/api/src/handlers/folio-collab/snapshot-store.ts",
  "apps/api/src/handlers/legal-reader/annotations/update.ts",
  "apps/api/src/handlers/lists/items/fact-details/update.ts",
  "apps/api/src/handlers/organization-settings/anonymization-blacklist/update.ts",
  "apps/api/src/handlers/organization-settings/practice-jurisdictions/update.ts",
  "apps/api/src/handlers/organization-settings/update-ai-config.ts",
  "apps/api/src/handlers/playbooks/update.ts",
  "apps/api/src/handlers/properties/update.ts",
  "apps/api/src/handlers/rates/arrangement/update.ts",
  "apps/api/src/handlers/saved-searches/update.ts",
  "apps/api/src/handlers/skills/proposals/update.ts",
  "apps/api/src/handlers/skills/resources/update.ts",
  "apps/api/src/handlers/skills/update.ts",
  "apps/api/src/handlers/style-sets/from-editor/update.ts",
  "apps/api/src/handlers/style-sets/replace.ts",
  "apps/api/src/handlers/tasks/update.ts",
  "apps/api/src/handlers/templates/document/update.ts",
  "apps/api/src/handlers/templates/update.ts",
  "apps/api/src/handlers/views/reorder.ts",
  "apps/api/src/handlers/views/update.ts",
  "POST /v1/desktop-edit-sessions/:sessionId/checkpoint",
] as const;

const REVISION_PRECONDITIONS = {
  billingArrangement: ["revision"],
  messageRevision: ["baseRevision", "selectedTextHash"],
  collaborationSnapshot: ["expectedGeneration", "expectedSnapshotRevision"],
  desktopCheckpoint: ["sessionToken"],
} as const;

type RevisionFields =
  (typeof REVISION_PRECONDITIONS)[keyof typeof REVISION_PRECONDITIONS];
type ReplaceContractDebtId = (typeof REPLACE_CONTRACT_DEBT_IDS)[number];

export type WriteContract =
  | { contract: "patch"; precondition?: never }
  | {
      contract: "replace";
      precondition:
        | { type: "updatedAt"; field: "expectedUpdatedAt" }
        | { type: "revision"; fields: RevisionFields }
        | { type: "deferred"; baselineId: ReplaceContractDebtId };
    };

type WritePreconditionArgs =
  | {
      type: "updatedAt";
      field: "expectedUpdatedAt";
      storedUpdatedAt: Date;
      expectedUpdatedAt: string;
      resource: string;
    }
  | {
      type: "revision";
      field: RevisionFields[number];
      storedRevision: string | number;
      expectedRevision: string | number;
      resource: string;
    };

/** Check every declared field after locking the decisive row, holding that lock through the write. */
export const enforceWritePrecondition = (
  args: WritePreconditionArgs,
): HandlerError<409> | null => {
  switch (args.type) {
    case "updatedAt":
      return assertUnchangedSince(args);
    case "revision":
      if (args.storedRevision === args.expectedRevision) {
        return null;
      }
      return new HandlerError({
        code: VERSION_CONFLICT_ERROR_CODE,
        status: 409,
        message: `${args.resource} changed while it was being edited; reload and try again`,
      });
    default:
      return panic(args satisfies never);
  }
};

const contracts = new WeakMap<object, WriteContract>();

const REVISION_TYPES = new Set(["string", "integer", "number"]);

/** A revision token: a string or a number, or a union of them. */
const isRevisionField = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const branches = schema["anyOf"] ?? schema["oneOf"];
  if (isUnknownArray(branches)) {
    return branches.length > 0 && branches.every(isRevisionField);
  }
  return (
    typeof schema["type"] === "string" && REVISION_TYPES.has(schema["type"])
  );
};

/**
 * Whether every body the schema accepts carries the token: a union requires
 * it in every alternative, an intersection in one conjunct. Read from the
 * body's JSON Schema rendering, which states exactly which fields are
 * required.
 */
const requiresField = (schema: unknown, field: string): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const branches = schema["anyOf"] ?? schema["oneOf"];
  if (isUnknownArray(branches)) {
    return (
      branches.length > 0 &&
      branches.every((branch) => requiresField(branch, field))
    );
  }
  const conjuncts = schema["allOf"];
  if (isUnknownArray(conjuncts)) {
    return conjuncts.some((branch) => requiresField(branch, field));
  }
  const required = schema["required"];
  const properties = schema["properties"];
  if (
    schema["type"] !== "object" ||
    !isUnknownArray(required) ||
    !required.includes(field) ||
    !isRecord(properties)
  ) {
    return false;
  }
  const value = properties[field];
  if (field === "expectedUpdatedAt") {
    return (
      isRecord(value) &&
      value["type"] === "string" &&
      value["format"] === "date-time"
    );
  }
  return isRevisionField(value);
};

const bodyRequiresField = (body: unknown, field: string): boolean =>
  isValibotSchema(body) && requiresField(toRouteJsonSchema(body), field);

type WriteContractConfig = WriteContract & {
  body?: unknown;
  description?: string;
};

/** Factory-time validation catches invalid declarations before any transport can invoke the handler. */
export const assertWriteContract = (
  config: WriteContractConfig,
  handlerName = config.description ?? "anonymous handler",
): void => {
  const failureMessage = (rule: string) => {
    const registration = { stack: "" };
    Error.captureStackTrace(registration, assertWriteContract);
    return `Invalid write contract for ${handlerName}: ${rule}\nHandler registration:\n${registration.stack}`;
  };
  if (
    /^Replace\b/iu.test(config.description?.trimStart() ?? "") &&
    config.contract !== "replace"
  ) {
    panic(failureMessage("A Replace description requires contract: replace"));
  }
  switch (config.contract) {
    case "patch":
      return;
    case "replace": {
      const precondition = config.precondition;
      if (!Object.hasOwn(config, "precondition")) {
        return panic(
          failureMessage("A replacement requires a declared precondition"),
        );
      }
      switch (precondition.type) {
        case "deferred":
          return;
        case "updatedAt":
          if (!bodyRequiresField(config.body, precondition.field)) {
            panic(
              failureMessage(
                "A replacement body must require expectedUpdatedAt in every branch",
              ),
            );
          }
          return;
        case "revision":
          for (const field of precondition.fields) {
            if (!bodyRequiresField(config.body, field)) {
              panic(
                failureMessage(
                  `A replacement body must require ${field} in every branch`,
                ),
              );
            }
          }
          return;
        default:
          precondition satisfies never;
          return panic(
            failureMessage(
              "A replacement precondition must be updatedAt, revision, or deferred",
            ),
          );
      }
    }
    default:
      config satisfies never;
      return panic(
        failureMessage("Declare contract: patch or contract: replace"),
      );
  }
};

/** Record at the safe factory boundary, never by replacing the function identity. */
export const recordWriteContract = (
  handler: object,
  config: WriteContractConfig,
): void => {
  const handlerName =
    typeof handler === "function" && handler.name.length > 0
      ? handler.name
      : (config.description ?? "anonymous handler");
  assertWriteContract(config, handlerName);
  contracts.set(handler, config);
};

export const getWriteContract = (handler: object) => contracts.get(handler);
