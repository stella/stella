import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  databaseComponentEnvSchema,
  envBaseServerSchema,
} from "@/api/env-base-schema";
import { envDocumentProcessingWorkerServerSchema } from "@/api/env-document-processing-worker-schema";
import { euCompletionTickServerSchema } from "@/api/env-eu-completion";
import { envOnlineIndexServerSchema } from "@/api/env-online-index";
import { replayTickServerSchema } from "@/api/env-replay";
import { envApiServerSchema } from "@/api/env-schema";
import { rateLimitBudgetEnvSchema } from "@/api/lib/rate-limit/budget-config-schema";
import { isRecord } from "@/api/lib/type-guards";

import { DATA_INVARIANT_ID } from "./invariant";
import { SHADOW_MODE, SHADOW_MODE_INVARIANTS } from "./shadow-modes";

/** Every environment schema the API's processes parse. */
const API_ENV_SCHEMAS = {
  envBaseServerSchema,
  databaseComponentEnvSchema,
  envApiServerSchema,
  envDocumentProcessingWorkerServerSchema,
  euCompletionTickServerSchema,
  envOnlineIndexServerSchema,
  replayTickServerSchema,
  rateLimitBudgetEnvSchema,
};

/** The literal values a setting's schema admits, through optional and union wrappers. */
const admittedValues = (schema: unknown): readonly unknown[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const { options, type } = schema;
  if (type === "picklist" && Array.isArray(options)) {
    return options;
  }
  if (type === "literal") {
    return [schema["literal"]];
  }
  if ((type === "union" || type === "variant") && Array.isArray(options)) {
    return options.flatMap(admittedValues);
  }
  return "wrapped" in schema ? admittedValues(schema["wrapped"]) : [];
};

const shadowModeKeys = (schemas: Readonly<Record<string, unknown>>) => {
  const keys = new Set<string>();
  for (const shape of Object.values(schemas)) {
    if (!isRecord(shape)) {
      continue;
    }
    for (const [key, schema] of Object.entries(shape)) {
      if (admittedValues(schema).includes(SHADOW_MODE)) {
        keys.add(key);
      }
    }
  }
  return [...keys].toSorted();
};

describe("shadow-mode census", () => {
  test("the census sees a shadow mode however its schema wraps it", () => {
    expect(
      shadowModeKeys({
        planted: {
          PICKLIST: v.optional(v.picklist(["off", SHADOW_MODE]), "off"),
          UNION: v.nullable(v.union([v.literal("on"), v.literal(SHADOW_MODE)])),
          PIPED: v.pipe(v.picklist([SHADOW_MODE, "on"]), v.readonly()),
          OTHER: v.optional(v.picklist(["off", "on"])),
          FREE_TEXT: v.string(),
        },
      }),
    ).toEqual(["PICKLIST", "PIPED", "UNION"]);
  });

  test("every shadow-mode setting declares an invariant, and every declaration is one", () => {
    const declared = Object.keys(SHADOW_MODE_INVARIANTS).toSorted();
    expect(declared.length).toBeGreaterThan(0);
    expect(shadowModeKeys(API_ENV_SCHEMAS)).toEqual(declared);
  });

  test("each declared invariant is a checked one", () => {
    const checked: ReadonlySet<string> = new Set(
      Object.values(DATA_INVARIANT_ID),
    );
    for (const ids of Object.values(SHADOW_MODE_INVARIANTS)) {
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(checked.has(id)).toBe(true);
      }
    }
  });
});
