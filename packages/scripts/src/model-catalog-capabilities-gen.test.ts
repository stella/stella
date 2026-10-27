import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { API } from "tsrs/unstable/async";

import { BYOK_MODEL_OPTIONS, TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import { resolveTemperaturePolicy } from "./model-catalog-capabilities";
import type { UpstreamCapabilities } from "./model-catalog-capabilities";
import {
  buildCapabilityRows,
  renderCapabilitiesModule,
} from "./model-catalog-capabilities-gen";
import { MODELS_DEV_KEY_BY_PROVIDER } from "./model-catalog-snapshot";

const offeredModelIds = TANSTACK_AI_PROVIDERS.flatMap((provider) =>
  BYOK_MODEL_OPTIONS[provider].map((modelId) => ({ provider, modelId })),
);

const upstreamWithToolCall = (
  toolCallFor: (modelId: string) => boolean | null,
): ReadonlyMap<string, UpstreamCapabilities> =>
  new Map(
    offeredModelIds.map(({ provider, modelId }) => [
      `${MODELS_DEV_KEY_BY_PROVIDER[provider]}:${modelId}`,
      {
        releaseDate: null,
        reasoning: false,
        effortValues: null,
        inputModalities: provider === "mistral" ? ["text", "pdf"] : ["text"],
        outputTokens: 8192,
        temperature: false,
        toolCall: toolCallFor(modelId),
      },
    ]),
  );

describe("tool-calling requirement", () => {
  const toolLessModelId = BYOK_MODEL_OPTIONS.bedrock.at(-1) ?? "";

  test("generates a row for every offered model that accepts tools", () => {
    const rows = buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
    });
    expect(rows.map((row) => row.modelId)).toEqual(
      offeredModelIds.map(({ modelId }) => modelId),
    );
  });

  test("rejects an offered model that cannot take tools", () => {
    expect(() =>
      buildCapabilityRows({
        openRouterDefaults: new Map(),
        upstream: upstreamWithToolCall(
          (modelId) => modelId !== toolLessModelId,
        ),
      }),
    ).toThrow(`bedrock/${toolLessModelId}: models.dev reports no tool calling`);
  });

  test("rejects a record that does not publish an output limit", () => {
    const upstream = new Map(
      [...upstreamWithToolCall(() => true)].map(([key, record]) => [
        key,
        key.endsWith(`:${toolLessModelId}`)
          ? { ...record, outputTokens: null }
          : record,
      ]),
    );
    expect(() =>
      buildCapabilityRows({ openRouterDefaults: new Map(), upstream }),
    ).toThrow(
      `bedrock/${toolLessModelId}: models.dev record lacks limit.output`,
    );
  });

  test("carries each model's output limit into its row", () => {
    const rows = buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
    });
    expect(new Set(rows.map(({ outputTokens }) => outputTokens))).toEqual(
      new Set([8192]),
    );
  });

  test("rejects a record that does not publish tool support", () => {
    expect(() =>
      buildCapabilityRows({
        openRouterDefaults: new Map(),
        upstream: upstreamWithToolCall((modelId) =>
          modelId === toolLessModelId ? null : true,
        ),
      }),
    ).toThrow("lacks the tool_call field");
  });
});

describe("capability module generation", () => {
  test("emits document-input models, source corrections, and empty providers", () => {
    const source = renderCapabilitiesModule([
      {
        defaultReasoningEffort: null,
        documentInput: true,
        imageInput: "supported",
        imageInputOverrideReason: null,
        documentInputOverrideReason: "2026-08-20: reviewed source correction",
        efforts: null,
        modelId: "gpt-test",
        outputTokens: 4096,
        overrideReason: null,
        provider: "openai",
        temperaturePolicy: "omit",
      },
      {
        defaultReasoningEffort: null,
        documentInput: false,
        imageInput: "unsupported",
        imageInputOverrideReason: null,
        documentInputOverrideReason: null,
        efforts: null,
        modelId: "gpt-text-only",
        outputTokens: 4096,
        overrideReason: null,
        provider: "openai",
        temperaturePolicy: "omit",
      },
    ]);

    expect(source).toContain(
      '// override: 2026-08-20: reviewed source correction\n    "gpt-test",',
    );
    expect(source).not.toContain('    "gpt-text-only",');
    expect(source).toContain("mistral: []");
  });
});

describe("temperature emission policy", () => {
  test("omits deprecated sampling parameters for the Gemini cutoff and future releases", () => {
    expect(
      resolveTemperaturePolicy({
        modelId: "gemini-3.5-flash",
        provider: "google",
        releaseDate: "2026-05-20",
        upstreamSupportsTemperature: true,
      }),
    ).toBe("emit");

    for (const candidate of [
      {
        modelId: "gemini-3.5-flash-lite",
        provider: "google" as const,
      },
      {
        modelId: "google/gemini-3.6-flash",
        provider: "openrouter" as const,
      },
      {
        modelId: "gemini-4.0-flash",
        provider: "google" as const,
      },
    ]) {
      expect(
        resolveTemperaturePolicy({
          ...candidate,
          releaseDate: "2026-07-21",
          upstreamSupportsTemperature: true,
        }),
        `${candidate.provider}/${candidate.modelId}`,
      ).toBe("omit");
    }
  });

  test("requires a release date before emitting temperature for Google models", () => {
    expect(() =>
      resolveTemperaturePolicy({
        modelId: "gemini-future",
        provider: "google",
        releaseDate: null,
        upstreamSupportsTemperature: true,
      }),
    ).toThrow("lacks a valid release_date");
  });

  test("omits rejected parameters and preserves supported non-Google parameters", () => {
    expect(
      resolveTemperaturePolicy({
        modelId: "claude-example",
        provider: "anthropic",
        releaseDate: null,
        upstreamSupportsTemperature: false,
      }),
    ).toBe("omit");
    expect(
      resolveTemperaturePolicy({
        modelId: "mistral-example",
        provider: "mistral",
        releaseDate: null,
        upstreamSupportsTemperature: true,
      }),
    ).toBe("emit");
  });
});

describe("image-input evidence", () => {
  test.each([
    { inputModalities: ["text", "image"], expected: "supported" },
    { inputModalities: ["text"], expected: "unsupported" },
    { inputModalities: null, expected: "unknown" },
  ] as const)(
    "preserves $expected modality evidence",
    ({ inputModalities, expected }) => {
      const upstream = new Map(upstreamWithToolCall(() => true));
      const key = "openai:gpt-5.4-mini";
      const record = upstream.get(key);
      expect(record).toBeDefined();
      if (record === undefined) {
        panic("Missing fixture record");
      }
      upstream.set(key, { ...record, inputModalities });
      const rows = buildCapabilityRows({
        openRouterDefaults: new Map(),
        upstream,
      });
      expect(
        rows.find(
          ({ provider, modelId }) =>
            provider === "openai" && modelId === "gpt-5.4-mini",
        )?.imageInput,
      ).toBe(expected);
    },
  );

  test("a reviewed image correction takes precedence over modality evidence", () => {
    const rows = buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
      imageInputOverrides: {
        openai: {
          "gpt-5.4-mini": {
            supported: true,
            reason:
              "2026-10-02: Reviewed correction: https://developers.openai.com/api/docs/guides/images-vision",
          },
        },
      },
    });
    const row = rows.find(
      ({ provider, modelId }) =>
        provider === "openai" && modelId === "gpt-5.4-mini",
    );
    expect(row?.imageInput).toBe("supported");
    expect(row?.imageInputOverrideReason).toContain(
      "https://developers.openai.com/",
    );
    expect(renderCapabilitiesModule(rows)).toContain(
      '"gpt-5.4-mini": "supported"',
    );
  });

  test("identical IDs retain independent provider evidence", () => {
    const rows = buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
    });
    const row = rows.at(0);
    if (row === undefined) {
      panic("Missing fixture row");
    }
    const source = renderCapabilitiesModule([
      {
        ...row,
        provider: "openai",
        modelId: "shared-model",
        imageInput: "supported",
      },
      {
        ...row,
        provider: "anthropic",
        modelId: "shared-model",
        imageInput: "unsupported",
      },
    ]);
    expect(source).toContain('openai: {\n    "shared-model": "supported",');
    expect(source).toContain(
      'anthropic: {\n    "shared-model": "unsupported",',
    );
  });

  test("the generated type guard rejects an offered ID without image evidence", async () => {
    const rows = buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
    });
    const source = renderCapabilitiesModule(rows);
    const declarations = (extraId: string) => `
      export type BYOKProvider = ${TANSTACK_AI_PROVIDERS.map((provider) => JSON.stringify(provider)).join(" | ")};
      export type BYOKModelIdByProvider = { ${TANSTACK_AI_PROVIDERS.map((provider) => `${provider}: ${BYOK_MODEL_OPTIONS[provider].map((id) => JSON.stringify(id)).join(" | ")}${provider === "openai" ? extraId : ""}`).join("; ")} };
      export type OfferedBYOKModelId = ${rows.map(({ modelId }) => JSON.stringify(modelId)).join(" | ")};
      export type ImageInputCapability = "supported" | "unsupported" | "unknown";
      export type ReasoningEffort = string;
      export type TemperaturePolicy = "emit" | "omit";
    `;
    const diagnostics = async (extraId: string) => {
      const directory = mkdtempSync(
        path.join(tmpdir(), "catalog-capabilities-"),
      );
      const config = path.join(directory, "tsconfig.json");
      const api = new API({ cwd: directory });
      try {
        writeFileSync(path.join(directory, "capabilities.gen.ts"), source);
        writeFileSync(path.join(directory, "index.ts"), declarations(extraId));
        writeFileSync(
          config,
          JSON.stringify({
            files: ["capabilities.gen.ts"],
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              module: "Preserve",
              moduleResolution: "Bundler",
            },
          }),
        );
        const snapshot = await api.createSnapshot({ openProjects: [config] });
        const project =
          snapshot.getConfiguredProject(config) ??
          panic("The generated capability fixture was not loaded");
        return await project.program.getSemanticDiagnostics();
      } finally {
        await api.close();
        rmSync(directory, { recursive: true, force: true });
      }
    };
    expect(await diagnostics("")).toEqual([]);
    const missing = await diagnostics(' | "additional-model"');
    expect(missing).toHaveLength(1);
    expect(missing.at(0)?.text ?? "").toContain("additional-model");
  });
});

test("source corrections expire when upstream image evidence agrees", () => {
  expect(() =>
    buildCapabilityRows({
      openRouterDefaults: new Map(),
      upstream: upstreamWithToolCall(() => true),
      imageInputOverrides: {
        openai: {
          "gpt-5.4-mini": {
            supported: false,
            reason:
              "2026-10-02: Reviewed correction: https://developers.openai.com/api/docs/guides/images-vision",
          },
        },
      },
    }),
  ).toThrow("Image-input override now agrees with models.dev");
});
