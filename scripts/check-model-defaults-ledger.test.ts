import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  MODEL_DEFAULTS_LEDGER,
  type ModelDefaultEntry,
  type ModelMode,
} from "../packages/ai-catalog/src/model-defaults-ledger";
import {
  checkModelDefaultsLedger,
  checkModelDefaultsSource,
  LEGACY_FIELD_BY_MODEL_CALL,
} from "./check-model-defaults-ledger";
import { addedEntries, parseReasonedLedger } from "./ledger-membership";

const exceptions = parseReasonedLedger(
  readFileSync(
    new URL("model-defaults-exceptions.json", import.meta.url),
    "utf-8",
  ),
  "model defaults exceptions",
);

const withGoogleChat = (entry: ModelDefaultEntry) => ({
  ...MODEL_DEFAULTS_LEDGER,
  chat: { ...MODEL_DEFAULTS_LEDGER.chat, google: entry },
});

describe("task model source ownership", () => {
  test("rejects legacy argument fields across task calls and imported aliases", () => {
    for (const [name, field] of Object.entries(LEGACY_FIELD_BY_MODEL_CALL)) {
      for (const key of [field, `"${field}"`, `["${field}"]`]) {
        for (const call of [name, "aliased", `models.${name}`]) {
          expect(
            checkModelDefaultsSource({
              relativePath: "apps/api/src/lib/example.ts",
              source: `import { ${name} as aliased } from "./models"; ${call}({ ${key}: "pdf" });`,
            }).length,
          ).toBeGreaterThan(0);
        }
      }
      expect(
        checkModelDefaultsSource({
          relativePath: "apps/api/src/lib/example.ts",
          source: `${name}({ ${field} });`,
        }).length,
      ).toBeGreaterThan(0);
    }
  });

  test("keeps message roles, override groups, and the storage column distinct from task inputs", () => {
    expect(
      checkModelDefaultsSource({
        relativePath: "apps/api/src/lib/example.ts",
        source: `generateTanStackObjectForTask({ task: "pdf", messages: [{ role: "user", content: "Question" }] });
        resolveCaching({ task: "pdf" });
        createTanStackAIAnalyticsCallbacks({ modelTask: "short-text" });
        recordUsageEvent({ modelTask: "short-text" });
        tx.insert(usageEvents).values({ modelRole: modelTask });
        isBYOKProviderRoleSupported({ provider: "google", role: "pdf" });`,
      }),
    ).toEqual([]);
    expect(
      checkModelDefaultsSource({
        relativePath: "apps/api/src/lib/example.ts",
        source:
          "generateTanStackObjectForTask({ role: DERIVE_ASK_ROLE }); resolveCaching({ role: DERIVE_ASK_ROLE });",
      }),
    ).toHaveLength(2);
  });

  test("rejects removed imports, aliases, and exported declarations", () => {
    for (const source of [
      'import type { ModelRole as Role } from "@stll/ai-catalog";',
      'import type { ModelTask as ModelRole } from "@stll/ai-catalog";',
      'import { MODEL_TASKS as MODEL_ROLES } from "@stll/ai-catalog";',
      'import { MODEL_ROLES, DEFAULT_MODELS as defaults } from "@stll/ai-catalog";',
      'import { generateTanStackTextForRole as generate } from "@/api/lib/tanstack-ai-generate";',
      "export { task as ModelRole };",
      'export { DEFAULT_MODELS as defaults } from "./catalog";',
      'export type ModelRole = "fast" | "chat";',
      'export const MODEL_ROLES = ["fast", "chat"];',
      "export function streamTanStackObjectForRole() {}",
    ]) {
      expect(
        checkModelDefaultsSource({
          relativePath: "apps/api/src/lib/example.ts",
          source,
        }).length,
      ).toBeGreaterThan(0);
    }
    for (const name of [
      "resolveOrgAIModelForRole",
      "getTanStackTextModelInfoForRole",
      "requireTanStackAIAvailableForRole",
      "isAllowedBYOKModelForRole",
      "isDeferredServiceTierAvailableForRole",
      "resolveWorkingBYOKModelForRole",
      "getTemperatureForRole",
    ]) {
      const relativePath = "apps/api/src/lib/example.ts";
      expect(
        checkModelDefaultsSource({
          relativePath,
          source: `import { ${name} as removed } from "./models";`,
        }),
      ).toEqual([
        `${relativePath}: ${name} is replaced by the task ledger contract`,
      ]);
    }
  });

  test("rejects a separate catalog runtime table and static BYOK model assignments", () => {
    const relativePath = "packages/ai-catalog/src/index.ts";
    expect(
      checkModelDefaultsSource({
        relativePath,
        source: 'const DEFAULT_MODELS = { google: { chat: "example" } };',
      }),
    ).toContain(
      `${relativePath}: DEFAULT_MODELS is replaced by the task ledger contract`,
    );
    expect(
      checkModelDefaultsSource({
        relativePath,
        source: 'type ModelRole = "fast" | "chat";',
      }),
    ).toContain(
      `${relativePath}: ModelRole is replaced by the task ledger contract`,
    );
    for (const key of ["modelId", '"modelId"', "'modelId'", '["modelId"]']) {
      expect(
        checkModelDefaultsSource({
          relativePath,
          source: `export const BYOK_DEFAULT_MODELS = { google: { chat: { ${key}: "example" } } };`,
        }),
      ).toContain(
        `${relativePath}: BYOK default model IDs must be projected from the task ledger`,
      );
    }
  });

  test("accepts task APIs, derived settings defaults, and unrelated role helpers", () => {
    expect(
      checkModelDefaultsSource({
        relativePath: "packages/ai-catalog/src/index.ts",
        source:
          "export const BYOK_DEFAULT_MODELS = { google: { chat: defaultPresentation(MODEL_DEFAULTS_LEDGER.chat.google) } };",
      }),
    ).toEqual([]);
    expect(
      checkModelDefaultsSource({
        relativePath: "apps/api/src/lib/example.ts",
        source:
          'import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate"; export const permissionForRole = () => true; const DEFAULT_MODELS = ["fixture"]; // ModelRole',
      }),
    ).toEqual([]);
  });
});

const selected = MODEL_DEFAULTS_LEDGER.chat.google;
const matchingQuality = {
  source: "local-eval",
  measurement: {
    status: "matching-mode",
    modelId: selected.candidate.modelId,
    provider: "google",
    measuredMode: selected.candidate.mode,
  },
} as const;
const measured = {
  ...selected,
  quality: matchingQuality,
} as const satisfies ModelDefaultEntry;
const retiredExceptions = exceptions.filter((id) => id !== "seed:chat:google");

describe("model defaults evidence guard", () => {
  test("enumerates every live seed and unsupported exception from the ledger", () => {
    expect(
      checkModelDefaultsLedger({ ledger: MODEL_DEFAULTS_LEDGER, exceptions }),
    ).toEqual([]);
  });

  test("rejects planted missing, duplicate, and stale exceptions", () => {
    expect(
      checkModelDefaultsLedger({
        ledger: MODEL_DEFAULTS_LEDGER,
        exceptions: retiredExceptions,
      }),
    ).toContain("seed:chat:google: missing model default exception");
    expect(
      checkModelDefaultsLedger({
        ledger: MODEL_DEFAULTS_LEDGER,
        exceptions: [...exceptions, "seed:chat:google"],
      }),
    ).toContain("model default exceptions must be duplicate-free");
    expect(
      checkModelDefaultsLedger({
        ledger: withGoogleChat(measured),
        exceptions,
      }),
    ).toContain("seed:chat:google: stale model default exception");
  });

  test("retires seed exemptions only for matching local or same-weights evidence", () => {
    for (const source of ["local-eval", "same-weights"] as const) {
      const entry = { ...measured, quality: { ...matchingQuality, source } };
      expect(
        checkModelDefaultsLedger({
          ledger: withGoogleChat(entry),
          exceptions: retiredExceptions,
        }),
      ).toEqual([]);
    }
    const external = {
      ...measured,
      quality: { ...matchingQuality, source: "external-benchmark" },
    } as const;
    expect(
      checkModelDefaultsLedger({
        ledger: withGoogleChat(external),
        exceptions: retiredExceptions,
      }),
    ).toContain(
      "chat/google: external benchmarks cannot qualify a measured default",
    );
  });

  test("rejects changing only the candidate model on measured evidence", () => {
    for (const source of [
      "local-eval",
      "same-weights",
      "external-benchmark",
    ] as const) {
      const entry = {
        ...measured,
        candidate: { ...measured.candidate, modelId: "gemini-3.7-flash" },
        quality: { ...matchingQuality, source },
      } as const satisfies ModelDefaultEntry;
      expect(entry.candidate.modelId).not.toBe(
        matchingQuality.measurement.modelId,
      );
      expect(entry.candidate.mode).toEqual(
        matchingQuality.measurement.measuredMode,
      );
      expect(
        checkModelDefaultsLedger({
          ledger: withGoogleChat(entry),
          exceptions: retiredExceptions,
        }),
      ).toContain(
        "chat/google: measured evidence must match the selected model",
      );
    }
  });

  test("rejects evidence measured through another provider", () => {
    const entry = {
      ...measured,
      quality: {
        ...matchingQuality,
        measurement: { ...matchingQuality.measurement, provider: "openrouter" },
      },
    } as const satisfies ModelDefaultEntry;
    expect(
      checkModelDefaultsLedger({
        ledger: withGoogleChat(entry),
        exceptions: retiredExceptions,
      }),
    ).toContain(
      "chat/google: measured evidence must match the selected provider",
    );
  });

  test("rejects mode changes including effort, sampling, and thinking shape", () => {
    const modes = [
      {
        type: "google-thinking",
        requestedEffort: "none",
        thinkingLevel: "MINIMAL",
        temperaturePolicy: "omit",
      },
      {
        type: "google-thinking",
        requestedEffort: "low",
        thinkingLevel: "LOW",
        temperaturePolicy: "omit",
      },
      {
        type: "google-thinking",
        requestedEffort: "none",
        thinkingLevel: "LOW",
        temperaturePolicy: "emit",
      },
      {
        type: "google-thinking",
        requestedEffort: "high",
        thinkingLevel: "HIGH",
        temperaturePolicy: "omit",
      },
      { type: "reasoning-effort", effort: "high", temperaturePolicy: "omit" },
      { type: "reasoning-effort", effort: "none", temperaturePolicy: "emit" },
      { type: "provider-default", temperaturePolicy: "omit" },
      {
        type: "anthropic-thinking",
        thinking: { type: "adaptive" },
        temperaturePolicy: "omit",
      },
      {
        type: "anthropic-thinking",
        thinking: { type: "enabled", budget_tokens: 1024 },
        temperaturePolicy: "omit",
      },
    ] as const satisfies readonly ModelMode[];
    for (const measuredMode of modes) {
      expect(measuredMode).not.toEqual(selected.candidate.mode);
      const entry = {
        ...measured,
        quality: {
          ...matchingQuality,
          measurement: { ...matchingQuality.measurement, measuredMode },
        },
      } as const;
      expect(
        checkModelDefaultsLedger({
          ledger: withGoogleChat(entry),
          exceptions: retiredExceptions,
        }),
      ).toContain(
        "chat/google: measured evidence must match the selected mode",
      );
    }
  });

  test("keeps different-mode benchmark evidence seeded and rejects a false mismatch", () => {
    const entry = {
      ...selected,
      quality: {
        source: "seed",
        measurement: {
          status: "different-mode",
          source: "external-benchmark",
          modelId: selected.candidate.modelId,
          provider: "google",
          measuredMode: selected.candidate.mode,
        },
      },
    } as const satisfies ModelDefaultEntry;
    expect(
      checkModelDefaultsLedger({ ledger: withGoogleChat(entry), exceptions }),
    ).toContain(
      "chat/google: different-mode evidence matches the selected mode",
    );
  });

  test("binds different-mode benchmark evidence to its model and provider", () => {
    const quality = {
      source: "seed",
      measurement: {
        status: "different-mode",
        source: "external-benchmark",
        modelId: selected.candidate.modelId,
        provider: "google",
        measuredMode: {
          ...selected.candidate.mode,
          requestedEffort: "high",
          thinkingLevel: "HIGH",
        },
      },
    } as const;
    const entry = { ...selected, quality } as const satisfies ModelDefaultEntry;
    expect(
      checkModelDefaultsLedger({ ledger: withGoogleChat(entry), exceptions }),
    ).toEqual([]);
    expect(
      checkModelDefaultsLedger({
        ledger: withGoogleChat({
          ...entry,
          candidate: { ...entry.candidate, modelId: "gemini-3.7-flash" },
        }),
        exceptions,
      }),
    ).toContain("chat/google: measured evidence must match the selected model");
    expect(
      checkModelDefaultsLedger({
        ledger: withGoogleChat({
          ...entry,
          quality: {
            ...quality,
            measurement: { ...quality.measurement, provider: "openrouter" },
          },
        }),
        exceptions,
      }),
    ).toContain(
      "chat/google: measured evidence must match the selected provider",
    );
  });

  test("rejects a planted additional unsupported pair even when listed", () => {
    const ledger = withGoogleChat({
      kind: "unsupported",
      reason: "document-input-unsupported",
    });
    expect(
      checkModelDefaultsLedger({
        ledger,
        exceptions: [...retiredExceptions, "unsupported:chat:google"],
      }),
    ).toContain(
      "chat/google: unsupported defaults require an existing document-input exception",
    );
  });

  test("membership accepts introduction and retirement but rejects swaps and reintroduction", () => {
    expect(addedEntries(exceptions, null)).toEqual([]);
    expect(addedEntries(retiredExceptions, exceptions)).toEqual([]);
    expect(addedEntries(exceptions, retiredExceptions)).toEqual([
      "seed:chat:google",
    ]);
    expect(
      addedEntries([...retiredExceptions, "seed:future:google"], exceptions),
    ).toEqual(["seed:future:google"]);
  });
});
