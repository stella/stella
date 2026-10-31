import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import { env } from "@/api/env";
import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  generateTanStackObjectForTask,
  streamTanStackObjectForTask,
} from "@/api/lib/tanstack-ai-generate";
import {
  createTanStackTextAdapterFactory,
  type ResolvedTanStackTextModel,
  tanStackModelOptionsForTask,
} from "@/api/lib/tanstack-ai-models";
import {
  recordedScenarioBody,
  streamCarrying,
} from "@/api/tests/helpers/provider-wire-answer";
import { loadProviderWireCassettes } from "@/api/tests/helpers/provider-wire-cassette";
import {
  STRUCTURED_OUTPUT_ENTRY_POINTS,
  STRUCTURED_OUTPUT_PASSTHROUGHS,
  STRUCTURED_OUTPUT_ROLE_FIXTURES,
  type StructuredOutputRoleFixture,
} from "@/api/tests/helpers/structured-output-role-fixtures";
import { createTestState } from "@/api/tests/helpers/test-state";

// Every structured-output role against every provider it reaches in
// production: the role's own schema, a recorded model answer for it, and the
// real adapter, SDK and engine in between, with only `fetch` answered from the
// provider's recorded wire stream carrying that answer. A role whose schema,
// projection or answer shape does not survive that path fails here rather
// than on every call in production.

const API_ROOT = path.resolve(import.meta.dir, "../..");
const SOURCE_ROOT = path.join(API_ROOT, "src");

/** The providers and models structured roles run on in production. */
const PROVIDER_MODELS = [
  { provider: "google", modelId: "gemini-3.8-flash" },
  { provider: "openrouter", modelId: "google/gemini-3.8-flash" },
  { provider: "anthropic", modelId: "claude-opus-5-5" },
  { provider: "openai", modelId: "gpt-6-luna" },
] as const;

type ProviderModel = (typeof PROVIDER_MODELS)[number];

const testState = createTestState({ file: import.meta.path, config: env });

testState.beforeAll(() => {
  // Real adapters, not the local mock model.
  testState.setConfig("USE_MOCK_AI", false);
  globalThis.fetch = answeringFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// --- Which roles exist ------------------------------------------------------

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)
      ? [full]
      : [];
  });

/** Code that is not a production role: the seam itself, local mocks, tests. */
const NOT_A_ROLE = ["lib/tanstack-ai-generate.ts", "dev/", "tests/"];

const ENTRY_POINT_CALL = new RegExp(
  `\\b(?:${STRUCTURED_OUTPUT_ENTRY_POINTS.join("|")})\\b`,
  "u",
);

/**
 * The schema each structured call in `source` passes, as written at the call
 * site: `outputSchema: <expression>,` or the shorthand `outputSchema,`.
 * Declarations (`outputSchema: TSchema;`) end in `;` and are not calls.
 */
const passedSchemas = (source: string): string[] =>
  [...source.matchAll(/^\s*outputSchema(?::\s*([^\n;]+?))?,\s*$/gmu)].map(
    (match) => match[1]?.trim() ?? "outputSchema",
  );

const discoveredRoles = (): Map<string, Set<string>> => {
  const roles = new Map<string, Set<string>>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const relative = repoRelativePath(SOURCE_ROOT, file);
    if (NOT_A_ROLE.some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    if (!ENTRY_POINT_CALL.test(source)) {
      continue;
    }
    const passthrough = STRUCTURED_OUTPUT_PASSTHROUGHS[relative] ?? [];
    const schemas = passedSchemas(source).filter(
      (schema) => !passthrough.includes(schema),
    );
    if (schemas.length > 0) {
      roles.set(relative, new Set(schemas));
    }
  }
  return roles;
};

const fixtureKey = ({ file, outputSchema }: StructuredOutputRoleFixture) =>
  `${file} ${outputSchema}`;

describe("structured-output role registry", () => {
  test("every structured call site has a recorded answer, and nothing else does", () => {
    const discovered = [...discoveredRoles()].flatMap(([file, schemas]) =>
      [...schemas].map((outputSchema) => `${file} ${outputSchema}`),
    );
    const registered = STRUCTURED_OUTPUT_ROLE_FIXTURES.map(fixtureKey);
    // A new structured call needs a fixture in
    // `tests/helpers/structured-output-role-fixtures.ts`: its schema as the
    // call site passes it and an answer a model really gives for it.
    expect(registered.toSorted()).toEqual(discovered.toSorted());
    expect(new Set(registered).size).toBe(registered.length);
  });

  test("the scan still finds the known call sites", () => {
    // Guards the scan itself: a regex that stopped matching would make the
    // registry check above pass on an empty set.
    expect(
      discoveredRoles().get("handlers/case-law/decisions/search-expand.ts"),
    ).toEqual(new Set(["expansionOutputSchema"]));
  });

  for (const fixture of STRUCTURED_OUTPUT_ROLE_FIXTURES) {
    test(`${fixtureKey(fixture)}: the recorded answer is one the schema accepts`, () => {
      const parsed = v.safeParse(fixture.schema, JSON.parse(fixture.answer));
      expect(parsed.issues).toBeUndefined();
    });
  }
});

// --- The round trip ---------------------------------------------------------

const cassettes = loadProviderWireCassettes();

const recordedTextBody = (provider: ProviderModel["provider"]) =>
  recordedScenarioBody(cassettes, provider, "text");

const realFetch = globalThis.fetch;
/** The answer the provider gives the round trip under way. */
const answering: {
  current: { provider: ProviderModel["provider"]; answer: string } | null;
} = { current: null };

const answeringFetch: typeof globalThis.fetch = Object.assign(
  async () => {
    const round = answering.current;
    if (round === null) {
      return panic("A provider request arrived outside a round trip");
    }
    const { body, headers } = recordedTextBody(round.provider);
    return new Response(streamCarrying(body, round.answer), {
      status: 200,
      headers,
    });
  },
  { preconnect: realFetch.preconnect },
);

const resolvedModel = ({
  provider,
  modelId,
}: ProviderModel): ResolvedTanStackTextModel => {
  const adapter = createTanStackTextAdapterFactory({
    provider,
    apiKey: "structured-output-contract-key",
    dataClass: "customer",
  })(modelId);
  // SAFETY: the provider and its own model options are built together from
  // one `provider`, which the union cannot see through the generic call.
  return {
    adapter,
    keySource: "byok",
    modelId,
    provider,
    modelOptions: tanStackModelOptionsForTask({
      modelId,
      organizationId: null,
      provider,
      task: "short-text",
    }),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY above
  } as ResolvedTanStackTextModel;
};

const objectOptions = (
  fixture: StructuredOutputRoleFixture,
  model: ResolvedTanStackTextModel,
) =>
  ({
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    caching: { enabled: false, reason: "org-disabled" },
    dataClass: "customer",
    managedAIResidency: "eu",
    organizationId: null,
    userId: null,
    orgAIConfig: null,
    outputSchema: fixture.schema,
    prompt: "Answer from the attached material.",
    resolveTextModel: () => model,
    task: "short-text",
    serviceTier: "standard",
    tenantWorkspaceIds: [],
  }) as const;

describe("structured-output roles round-trip through every provider", () => {
  for (const fixture of STRUCTURED_OUTPUT_ROLE_FIXTURES) {
    for (const providerModel of PROVIDER_MODELS) {
      const name = `${fixtureKey(fixture)} via ${providerModel.provider}`;
      const expected = v.parse(fixture.schema, JSON.parse(fixture.answer));

      test(`${name}: awaited`, async () => {
        answering.current = {
          provider: providerModel.provider,
          answer: fixture.answer,
        };
        const model = resolvedModel(providerModel);
        const object = await generateTanStackObjectForTask(
          objectOptions(fixture, model),
        );
        expect(object).toEqual(expected);
      });

      test(`${name}: streamed`, async () => {
        answering.current = {
          provider: providerModel.provider,
          answer: fixture.answer,
        };
        const model = resolvedModel(providerModel);
        let completed: unknown;
        for await (const event of streamTanStackObjectForTask(
          objectOptions(fixture, model),
        )) {
          if (event.type === "complete") {
            completed = event.object;
          }
        }
        expect(completed).toEqual(expected);
      });
    }
  }
});
