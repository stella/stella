import { Kind } from "@sinclair/typebox";
import { panic } from "better-result";

import { HandlerError } from "./errors/tagged-errors";
import {
  assertUnchangedSince,
  VERSION_CONFLICT_ERROR_CODE,
} from "./optimistic-concurrency";

/** Exact migration identities; the route census binds these to the reasoned baseline. */
const REPLACE_CONTRACT_DEBT_IDS = [
  "apps/api/src/handlers/case-law/research/columns-reorder.ts",
  "apps/api/src/handlers/chat/messages/revisions/accept.ts",
  "apps/api/src/handlers/clauses/update.ts",
  "apps/api/src/handlers/clauses/variants/update.ts",
  "apps/api/src/handlers/document-types/reorder.ts",
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-sessions/:sessionId/checkpoint",
  "apps/api/src/handlers/entities/versions/upload.ts",
  "apps/api/src/handlers/entity-views/reorder.ts",
  "apps/api/src/handlers/entity-views/update.ts",
  "apps/api/src/handlers/fields/upsert.ts",
  "apps/api/src/handlers/flows/update.ts",
  "apps/api/src/handlers/folio-collab/snapshot-store.ts",
  "apps/api/src/handlers/legal-reader/annotations/update.ts",
  "apps/api/src/handlers/lists/items/fact-details/update.ts",
  "apps/api/src/handlers/playbooks/update.ts",
  "apps/api/src/handlers/properties/update.ts",
  "apps/api/src/handlers/rates/arrangement/update.ts",
  "apps/api/src/handlers/saved-searches/update.ts",
  "apps/api/src/handlers/skills/proposals/update.ts",
  "apps/api/src/handlers/skills/resources/update.ts",
  "apps/api/src/handlers/skills/update.ts",
  "apps/api/src/handlers/style-sets/from-editor/update.ts",
  "apps/api/src/handlers/style-sets/replace.ts",
  "apps/api/src/handlers/templates/document/update.ts",
  "apps/api/src/handlers/templates/update.ts",
  "apps/api/src/handlers/views/reorder.ts",
  "apps/api/src/handlers/views/update.ts",
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

/** Custom transport boundaries declare the same contract without changing handler identities. */
export const RAW_WRITE_CONTRACTS = {
  "apps/api/src/handlers/agent-auth/routes.ts|POST|/agent/event/notify": {
    contract: "patch",
  },
  "apps/api/src/handlers/dev/routes.ts|POST|/dev/clean": {
    contract: "patch",
  },
  "apps/api/src/handlers/dev/routes.ts|POST|/dev/clear-cache": {
    contract: "patch",
  },
  "apps/api/src/handlers/dev/routes.ts|POST|/dev/public-law-connection": {
    contract: "patch",
  },
  "apps/api/src/handlers/dev/routes.ts|POST|/dev/rebuild-search": {
    contract: "patch",
  },
  "apps/api/src/handlers/dev/routes.ts|POST|/dev/seed-firm-knowledge": {
    contract: "patch",
  },
  "apps/api/src/handlers/dev/routes.ts|POST|/dev/seed": {
    contract: "patch",
  },
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-handoffs/:handoffId/opened":
    {
      contract: "patch",
    },
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-handoffs/redeem":
    {
      contract: "patch",
    },
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-sessions/:sessionId/checkpoint":
    {
      contract: "replace",
      precondition: {
        type: "deferred",
        baselineId:
          "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-sessions/:sessionId/checkpoint",
      },
    },
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-sessions/:sessionId/finalize":
    {
      contract: "patch",
    },
  "apps/api/src/handlers/entities/desktop-edit-sessions-route.ts|POST|/desktop-edit-sessions/:sessionId/respond-takeover":
    {
      contract: "patch",
    },
  "apps/api/src/handlers/feedback/routes.ts|POST|/public/feedback": {
    contract: "patch",
  },
  "apps/api/src/handlers/hosted-usage-webhook/routes.ts|POST|/usage/hosted/webhook":
    {
      contract: "patch",
    },
  "apps/api/src/handlers/mcp/routes-core.ts|ALL|/mcp-anonymized": {
    contract: "patch",
  },
  "apps/api/src/handlers/mcp/routes-core.ts|ALL|/mcp-documents": {
    contract: "patch",
  },
  "apps/api/src/handlers/mcp/routes-core.ts|ALL|/mcp-law": {
    contract: "patch",
  },
  "apps/api/src/handlers/mcp/routes-core.ts|ALL|/mcp/advanced": {
    contract: "patch",
  },
  "apps/api/src/handlers/mcp/routes-core.ts|ALL|/mcp": {
    contract: "patch",
  },
  "apps/api/src/handlers/smoke/routes.ts|POST|/smoke/session": {
    contract: "patch",
  },
  "apps/api/src/server.ts|MOUNT|": {
    contract: "patch",
  },
} as const satisfies Record<string, WriteContract>;

/** Custom transport identity excludes inline handler source text. */
export const writeContractRouteKey = (key: string) =>
  key.split("|").slice(0, 3).join("|");

const contracts = new WeakMap<object, WriteContract>();

// Elysia integer/number schemas transform a union of numeric strings and numbers.
const isRevisionField = (schema: unknown): boolean => {
  if (typeof schema !== "object" || schema === null || !(Kind in schema)) {
    return false;
  }
  switch (schema[Kind]) {
    case "String":
    case "Integer":
    case "Number":
      return true;
    case "Union":
      return (
        "anyOf" in schema &&
        Array.isArray(schema.anyOf) &&
        schema.anyOf.length > 0 &&
        schema.anyOf.every(isRevisionField)
      );
    default:
      return false;
  }
};

/** TypeBox unions require the token in every alternative; an intersection may supply it in one conjunct. */
const requiresField = (schema: unknown, field: string): boolean => {
  if (typeof schema !== "object" || schema === null || !(Kind in schema)) {
    return false;
  }
  switch (schema[Kind]) {
    case "Object": {
      if (
        !("type" in schema) ||
        schema.type !== "object" ||
        !("required" in schema) ||
        !Array.isArray(schema.required) ||
        !schema.required.includes(field) ||
        !("properties" in schema) ||
        typeof schema.properties !== "object" ||
        schema.properties === null
      ) {
        return false;
      }
      const value: unknown = Object.entries(schema.properties)
        .find(([key]) => key === field)
        ?.at(1);
      if (typeof value !== "object" || value === null || !(Kind in value)) {
        return false;
      }
      if (field === "expectedUpdatedAt") {
        return (
          value[Kind] === "String" &&
          "format" in value &&
          value.format === "date-time"
        );
      }
      return isRevisionField(value);
    }
    case "Union":
      return (
        "anyOf" in schema &&
        Array.isArray(schema.anyOf) &&
        schema.anyOf.length > 0 &&
        schema.anyOf.every((branch) => requiresField(branch, field))
      );
    case "Intersect":
      return (
        "allOf" in schema &&
        Array.isArray(schema.allOf) &&
        schema.allOf.some((branch) => requiresField(branch, field))
      );
    default:
      return false;
  }
};

type WriteContractConfig = WriteContract & {
  body?: unknown;
  description?: string;
};

/** Factory-time validation catches invalid declarations before any transport can invoke the handler. */
export const assertWriteContract = (config: WriteContractConfig): void => {
  if (
    /^Replace\b/iu.test(config.description?.trimStart() ?? "") &&
    config.contract !== "replace"
  ) {
    panic("A Replace description requires contract: replace");
  }
  switch (config.contract) {
    case "patch":
      return;
    case "replace": {
      const precondition = config.precondition;
      switch (precondition.type) {
        case "deferred":
          return;
        case "updatedAt":
          if (!requiresField(config.body, precondition.field)) {
            panic(
              "A replacement body must require expectedUpdatedAt in every branch",
            );
          }
          return;
        case "revision":
          for (const field of precondition.fields) {
            if (!requiresField(config.body, field)) {
              panic(`A replacement body must require ${field} in every branch`);
            }
          }
          return;
        default:
          return panic(precondition satisfies never);
      }
    }
    default:
      return panic(config satisfies never);
  }
};

/** Record at the safe factory boundary, never by replacing the function identity. */
export const recordWriteContract = (
  handler: object,
  config: WriteContractConfig,
): void => {
  assertWriteContract(config);
  contracts.set(handler, config);
};

export const getWriteContract = (handler: object) => contracts.get(handler);
