/**
 * Benchmark the chat readonly data surface with a cheap model.
 *
 * Usage:
 *   bun apps/api/scripts/benchmark-chat-read-surface.ts
 *   AI_BENCH_REPEATS=3 bun apps/api/scripts/benchmark-chat-read-surface.ts
 *   AI_BENCH_MODEL=gpt-5.4-nano bun apps/api/scripts/benchmark-chat-read-surface.ts
 *   bun apps/api/scripts/benchmark-chat-read-surface.ts --surface new-inline
 *   bun apps/api/scripts/benchmark-chat-read-surface.ts --json
 */

import { EventType, chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { TokenUsage, Tool } from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  mergeGenerationOptions,
  systemPromptsPatch,
} from "@/api/lib/tanstack-ai-generate";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";

const surfaces = ["old-mixed", "new-describe", "new-inline"] as const;

type Surface = (typeof surfaces)[number];

type BenchTask = {
  expected: readonly string[];
  id: string;
  prompt: string;
  simple: boolean;
};

type ToolTrace = {
  code?: string;
  error?: string;
  input: unknown;
  name: string;
};

type BenchTrace = {
  tools: ToolTrace[];
};

type SimulatedCall = {
  function: string;
  result: SimulatedReadResult;
};

type SimulatedReadResult =
  | {
      items: unknown[];
      hasMore?: boolean;
      nextOffset?: number | null;
    }
  | {
      calls: SimulatedCall[];
    }
  | {
      error: string;
    };

type RunScore = {
  catalogCalls: number;
  failedToolCalls: number;
  latencyMs: number;
  passed: boolean;
  rightSurface: boolean;
  shapeError: boolean;
  toolCalls: number;
  usedCanonicalRead: boolean;
  wrongNamespace: boolean;
};

type BenchRun = {
  finalText: string;
  repeat: number;
  score: RunScore;
  surface: Surface;
  taskId: string;
  tools: ToolTrace[];
  usage: TokenUsage | null;
};

const tasks = [
  {
    id: "latest-signing-date",
    simple: false,
    prompt:
      "Matter ref mat_1 is active. Which document in it has the latest signing date?",
    expected: ["OneSaaS v1.0.pdf", "2025"],
  },
  {
    id: "contact-search",
    simple: true,
    prompt: "List contacts matching Acme.",
    expected: ["Acme s.r.o.", "legal@acme.example"],
  },
  {
    id: "termination-search",
    simple: true,
    prompt:
      "In matter mat_1, search for termination documents and name the best hit.",
    expected: ["Termination notice.docx"],
  },
  {
    id: "count-documents",
    simple: true,
    prompt: "How many documents are in matter mat_1?",
    expected: ["3"],
  },
  {
    id: "read-content",
    simple: true,
    prompt:
      "In matter mat_1, read document ent_1 and tell me the governing law.",
    expected: ["Czech law"],
  },
] as const satisfies readonly BenchTask[];

const matterItems = [
  {
    matterRef: "mat_1",
    name: "Acme v OneSaaS",
    workspaceRef: "ws_1",
  },
];

const contactItems = [
  {
    contactRef: "contact_1",
    email: "legal@acme.example",
    name: "Acme s.r.o.",
    role: "Client",
  },
];

const documentItems = [
  {
    entityRef: "ent_1",
    kind: "document",
    matterRef: "mat_1",
    name: "OneSaaS v1.0.pdf",
    signingDate: "2025-03-01",
  },
  {
    entityRef: "ent_2",
    kind: "document",
    matterRef: "mat_1",
    name: "Termination notice.docx",
    signingDate: "2024-12-10",
  },
  {
    entityRef: "ent_3",
    kind: "document",
    matterRef: "mat_1",
    name: "Board minutes.pdf",
    signingDate: "2025-01-15",
  },
];

const contentItems = [
  {
    entityRef: "ent_1",
    name: "OneSaaS v1.0.pdf",
    text: "Subscription agreement signed on March 1, 2025. Governing law: Czech law.",
  },
  {
    entityRef: "ent_2",
    name: "Termination notice.docx",
    text: "Termination notice effective December 31, 2024.",
  },
  {
    entityRef: "ent_3",
    name: "Board minutes.pdf",
    text: "Board minutes approved January 15, 2025.",
  },
];

const readCatalog = [
  "read.listMatters({ query?, limit?, offset? }) -> { items, hasMore, nextOffset }",
  "read.getMatters({ matterRefs }) -> { items }",
  "read.listContacts({ query?, limit?, offset? }) -> { items, hasMore, nextOffset }",
  "read.getContacts({ contactRefs }) -> { items }",
  "read.searchMatterDocuments({ matterRefs, query, limit?, offset? }) -> { items, hasMore, nextOffset }",
  "read.listMatterEntities({ matterRefs, limit?, offset? }) -> { items, hasMore, nextOffset }",
  "read.getMatterEntities({ matterRefs, entityRefs }) -> { items }",
  "read.getMatterEntityContents({ matterRefs, entityRefs }) -> { items }",
] as const;

const oldMixedSystem = [
  "You answer questions for stella, a legal workspace.",
  "The read surface is mixed:",
  "- Direct read tools exist for focused reads.",
  "- Sandbox reads use describe-stella-function plus execute-typescript with stella.*.",
  "- Direct tools and sandbox reads do not share one output shape.",
  "Direct tool shapes:",
  "- search-across-matters returns { hits }.",
  "- read-content-across-matters returns { contents }.",
  "- read-contact requires an exact contactRef and returns one contact.",
  "Sandbox read functions may return { items } or { items, hasMore, nextOffset }.",
  "Answer concisely from tool results. Do not make up data.",
].join("\n");

const newDescribeSystem = [
  "You answer questions for stella, a legal workspace.",
  "For stella data reads, use the stella API:",
  "1. call describe-stella-api if you need the catalog",
  "2. call run-stella-query with TypeScript that uses read.*",
  "3. every read result stores records in result.items",
  "Answer concisely from tool results. Do not make up data.",
].join("\n");

const newInlineSystem = [
  "You answer questions for stella, a legal workspace.",
  "For stella data reads, call run-stella-query with TypeScript that uses read.*.",
  "Every read result stores records in result.items.",
  "Available reads:",
  ...readCatalog.map((entry) => `- ${entry}`),
  "Answer concisely from tool results. Do not make up data.",
].join("\n");

type Args = {
  json: boolean;
  repeats: number;
  surface: Surface | "all";
};

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
};

const parseSurface = (value: string | undefined): Surface | "all" => {
  if (!value || value === "all") {
    return "all";
  }

  for (const surface of surfaces) {
    if (surface === value) {
      return surface;
    }
  }

  return panic(
    `Unknown surface "${value}". Use one of: all, ${surfaces.join(", ")}.`,
  );
};

const parseArgs = (): Args => {
  const args = process.argv.slice(2);
  const parsed: Args = {
    json: process.env["AI_BENCH_JSON"] === "true",
    repeats: parsePositiveInteger(process.env["AI_BENCH_REPEATS"], 1),
    surface: parseSurface(process.env["AI_BENCH_SURFACE"]),
  };

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === "--repeats" && next) {
      parsed.repeats = parsePositiveInteger(next, parsed.repeats);
      i++;
      continue;
    }
    if (args[i] === "--surface" && next) {
      parsed.surface = parseSurface(next);
      i++;
      continue;
    }
    if (args[i] === "--json") {
      parsed.json = true;
    }
  }

  return parsed;
};

type BenchModel = {
  model: ResolvedTanStackTextModel;
  id: string;
  provider: string;
};

const getBenchModel = async (): Promise<BenchModel | null> => {
  const {
    getTanStackTextModelById,
    getTanStackTextModelForRole,
    getTanStackTextModelInfoForRole,
    hasTanStackInstanceProvider,
  } = await import("@/api/lib/tanstack-ai-models");

  if (!hasTanStackInstanceProvider()) {
    return null;
  }

  const overrideModel = process.env["AI_BENCH_MODEL"];
  if (overrideModel) {
    const info = getTanStackTextModelInfoForRole("fast", null, {
      organizationId: null,
    });
    const model = getTanStackTextModelById(overrideModel, null, {
      role: "fast",
      organizationId: null,
    });
    return {
      id: overrideModel,
      model,
      provider: info.provider,
    };
  }

  const info = getTanStackTextModelInfoForRole("fast", null, {
    organizationId: null,
  });
  const model = getTanStackTextModelForRole("fast", null, {
    organizationId: null,
  });
  return {
    id: info.modelId,
    model,
    provider: info.provider,
  };
};

const addTrace = ({
  code,
  error,
  input,
  name,
  trace,
}: {
  code?: string | undefined;
  error?: string | undefined;
  input: unknown;
  name: string;
  trace: BenchTrace;
}) => {
  trace.tools.push({
    ...(code === undefined ? {} : { code }),
    ...(error === undefined ? {} : { error }),
    input,
    name,
  });
};

const itemsResult = (
  items: unknown[],
): {
  items: unknown[];
} => ({
  items,
});

const paginatedResult = (
  items: unknown[],
): {
  hasMore: boolean;
  items: unknown[];
  nextOffset: null;
} => ({
  hasMore: false,
  items,
  nextOffset: null,
});

const runReadFunction = ({
  code,
  name,
}: {
  code: string;
  name: string;
}): SimulatedReadResult => {
  if (name === "listMatters" || name === "getMatters") {
    return itemsResult(matterItems);
  }

  if (name === "listContacts" || name === "getContacts") {
    return name === "listContacts"
      ? paginatedResult(contactItems)
      : itemsResult(contactItems);
  }

  if (name === "searchMatterDocuments") {
    return code.toLowerCase().includes("termination")
      ? paginatedResult([documentItems[1]])
      : paginatedResult(documentItems);
  }

  if (name === "listMatterEntities" || name === "getMatterEntities") {
    return name === "listMatterEntities"
      ? paginatedResult(documentItems)
      : itemsResult(documentItems);
  }

  if (name === "getMatterEntityContents") {
    return itemsResult(contentItems);
  }

  return {
    error: `Unknown read function: ${name}`,
  };
};

const getCalledFunctions = (code: string, namespace: "read" | "stella") => {
  const pattern = new RegExp(`\\b${namespace}\\.([A-Za-z][A-Za-z0-9_]*)`, "gu");
  const names = new Set<string>();

  for (
    let match = pattern.exec(code);
    match !== null;
    match = pattern.exec(code)
  ) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }

  return [...names];
};

const validateSimulatedCall = ({
  code,
  name,
}: {
  code: string;
  name: string;
}) => {
  if (
    [
      "getMatterEntities",
      "getMatterEntityContents",
      "getMatterProperties",
      "listMatterEntities",
      "listMatterProperties",
      "searchMatterDocuments",
    ].includes(name) &&
    !/\bmatterRefs\s*:/u.test(code)
  ) {
    return `${name} input must include matterRefs.`;
  }

  if (
    ["getMatterEntities", "getMatterEntityContents"].includes(name) &&
    !/\bentityRefs\s*:/u.test(code)
  ) {
    return `${name} input must include entityRefs.`;
  }

  if (name === "getMatterProperties" && !/\bpropertyRefs\s*:/u.test(code)) {
    return "getMatterProperties input must include propertyRefs.";
  }

  if (name === "getContacts" && !/\bcontactRefs\s*:/u.test(code)) {
    return "getContacts input must include contactRefs.";
  }

  if (name !== "searchMatterDocuments") {
    return null;
  }

  if (!/\bquery\s*:/u.test(code)) {
    return "searchMatterDocuments input must include query.";
  }

  if (/\bquery\s*:\s*[{[]/u.test(code)) {
    return "searchMatterDocuments query must be a string.";
  }

  return null;
};

const simulateSandbox = ({
  code,
  expectedNamespace,
}: {
  code: string;
  expectedNamespace: "read" | "stella";
}) => {
  const wrongNamespace = expectedNamespace === "read" ? "stella" : "read";
  if (new RegExp(`\\b${wrongNamespace}\\.`, "u").test(code)) {
    return {
      durationMs: 1,
      hostCalls: 0,
      value: {
        error: `Wrong namespace: use ${expectedNamespace}.* here, not ${wrongNamespace}.*.`,
      },
    };
  }

  const functionNames = getCalledFunctions(code, expectedNamespace);
  if (functionNames.length === 0) {
    return {
      durationMs: 1,
      hostCalls: 0,
      value: {
        error: `No ${expectedNamespace}.* read function call found in code.`,
      },
    };
  }

  const calls: SimulatedCall[] = [];
  for (const name of functionNames) {
    const validationError = validateSimulatedCall({
      code,
      name,
    });

    if (validationError) {
      calls.push({
        function: name,
        result: {
          error: validationError,
        },
      });
      continue;
    }

    calls.push({
      function: name,
      result: runReadFunction({
        code,
        name,
      }),
    });
  }

  const singleCall = calls.at(0);
  const value =
    calls.length === 1 && singleCall !== undefined
      ? singleCall.result
      : { calls };

  return {
    durationMs: 1,
    hostCalls: calls.length,
    value,
  };
};

const buildOldTools = (trace: BenchTrace) => ({
  "describe-stella-function": toolDefinition({
    name: "describe-stella-function",
    description:
      "Describe available stella sandbox read functions. Omit name to list them.",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        name: v.optional(v.string()),
      }),
    ),
  }).server(({ name }) => {
    const input = { name };
    addTrace({
      input,
      name: "describe-stella-function",
      trace,
    });

    if (name) {
      return {
        function: `${name} returns { items } or { items, hasMore, nextOffset }.`,
      };
    }

    return {
      functions: readCatalog.map((entry) => entry.replace("read.", "stella.")),
    };
  }),
  "execute-typescript": toolDefinition({
    name: "execute-typescript",
    description:
      "Run TypeScript against stella sandbox reads through stella.*.",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        code: v.string(),
      }),
    ),
  }).server(({ code }) => {
    const output = simulateSandbox({
      code,
      expectedNamespace: "stella",
    });
    const error = "error" in output.value ? output.value.error : undefined;
    addTrace({
      code,
      error,
      input: { code },
      name: "execute-typescript",
      trace,
    });
    return output;
  }),
  "read-contact": toolDefinition({
    name: "read-contact",
    description: "Read one contact by exact contactRef.",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        contactRef: v.string(),
      }),
    ),
  }).server(({ contactRef }) => {
    const input = { contactRef };
    const contact = contactItems.find(
      (candidate) => candidate.contactRef === contactRef,
    );
    const error = contact ? undefined : "Contact not found";
    addTrace({
      error,
      input,
      name: "read-contact",
      trace,
    });
    return contact ?? { error };
  }),
  "read-content-across-matters": toolDefinition({
    name: "read-content-across-matters",
    description:
      "Read document contents by entityRefs across accessible matters.",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        entityRefs: v.array(v.string()),
      }),
    ),
  }).server(({ entityRefs }) => {
    const input = { entityRefs };
    const contents = contentItems.filter((item) =>
      entityRefs.includes(item.entityRef),
    );
    addTrace({
      input,
      name: "read-content-across-matters",
      trace,
    });
    return {
      contents,
    };
  }),
  "search-across-matters": toolDefinition({
    name: "search-across-matters",
    description:
      "Search documents across accessible matters. Returns { hits }.",
    inputSchema: toTanStackToolSchema(
      v.strictObject({
        query: v.string(),
      }),
    ),
  }).server(({ query }) => {
    const input = { query };
    const normalizedQuery = query.toLowerCase();
    const hits = normalizedQuery.includes("termination")
      ? [documentItems[1]]
      : documentItems;
    addTrace({
      input,
      name: "search-across-matters",
      trace,
    });
    return {
      hits,
    };
  }),
});

const buildNewTools = ({
  includeDescribe,
  trace,
}: {
  includeDescribe: boolean;
  trace: BenchTrace;
}) => {
  const runner = {
    "run-stella-query": toolDefinition({
      name: "run-stella-query",
      description:
        "Run TypeScript against stella readonly reads through read.*.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          code: v.string(),
        }),
      ),
    }).server(({ code }) => {
      const output = simulateSandbox({
        code,
        expectedNamespace: "read",
      });
      const error = "error" in output.value ? output.value.error : undefined;
      addTrace({
        code,
        error,
        input: { code },
        name: "run-stella-query",
        trace,
      });
      return output;
    }),
  };

  if (!includeDescribe) {
    return runner;
  }

  return {
    "describe-stella-api": toolDefinition({
      name: "describe-stella-api",
      description:
        "Describe available stella readonly read functions. Omit name to list them.",
      inputSchema: toTanStackToolSchema(
        v.strictObject({
          name: v.optional(v.string()),
        }),
      ),
    }).server(({ name }) => {
      const input = { name };
      addTrace({
        input,
        name: "describe-stella-api",
        trace,
      });

      if (name) {
        return {
          function: readCatalog.find((entry) =>
            entry.startsWith(`read.${name}`),
          ),
        };
      }

      return {
        functions: readCatalog,
      };
    }),
    ...runner,
  };
};

const getSurfaceSystem = (surface: Surface) => {
  if (surface === "old-mixed") {
    return oldMixedSystem;
  }

  if (surface === "new-inline") {
    return newInlineSystem;
  }

  return newDescribeSystem;
};

const getSurfaceTools = ({
  surface,
  trace,
}: {
  surface: Surface;
  trace: BenchTrace;
}): Tool[] => {
  if (surface === "old-mixed") {
    return Object.values(buildOldTools(trace));
  }

  return Object.values(
    buildNewTools({
      includeDescribe: surface === "new-describe",
      trace,
    }),
  );
};

const includesAllExpected = ({
  expected,
  text,
}: {
  expected: readonly string[];
  text: string;
}) => {
  const normalizedText = text.toLowerCase();

  for (const value of expected) {
    if (!normalizedText.includes(value.toLowerCase())) {
      return false;
    }
  }

  return true;
};

const traceHasCodePattern = (trace: BenchTrace, pattern: RegExp) =>
  trace.tools.some((entry) => entry.code && pattern.test(entry.code));

const scoreRun = ({
  latencyMs,
  surface,
  task,
  text,
  trace,
}: {
  latencyMs: number;
  surface: Surface;
  task: BenchTask;
  text: string;
  trace: BenchTrace;
}): RunScore => {
  const toolNames = trace.tools.map((entry) => entry.name);
  const runnerName =
    surface === "old-mixed" ? "execute-typescript" : "run-stella-query";
  const catalogCalls = toolNames.filter((name) =>
    name.startsWith("describe-stella"),
  ).length;
  const failedToolCalls = trace.tools.filter((entry) => entry.error).length;
  const hasRunner = toolNames.includes(runnerName);
  const hasOldDirectRead = toolNames.some((name) =>
    [
      "read-contact",
      "read-content-across-matters",
      "search-across-matters",
    ].includes(name),
  );
  const usedCanonicalRead =
    surface === "old-mixed" ? false : hasRunner && !hasOldDirectRead;
  const wrongNamespace =
    surface === "old-mixed"
      ? traceHasCodePattern(trace, /\bread\./u)
      : traceHasCodePattern(trace, /\bstella\./u);
  const shapeError =
    surface === "old-mixed"
      ? traceHasCodePattern(trace, /\.items\b/u) && hasOldDirectRead
      : traceHasCodePattern(trace, /\.hits\b|\.contents\b|\.entities\b/u);

  return {
    catalogCalls,
    failedToolCalls,
    latencyMs,
    passed: includesAllExpected({
      expected: task.expected,
      text,
    }),
    rightSurface:
      surface === "old-mixed"
        ? hasOldDirectRead || hasRunner
        : usedCanonicalRead && !wrongNamespace,
    shapeError,
    toolCalls: trace.tools.length,
    usedCanonicalRead,
    wrongNamespace,
  };
};

const runBenchTask = async ({
  model,
  repeat,
  surface,
  task,
}: {
  model: ResolvedTanStackTextModel;
  repeat: number;
  surface: Surface;
  task: BenchTask;
}): Promise<BenchRun> => {
  const trace: BenchTrace = {
    tools: [],
  };
  const start = performance.now();
  const caching = resolveCaching({
    promptCachingEnabled: true,
    role: "fast",
    scopeKey: null,
  });
  const stream = chat({
    adapter: model.adapter,
    messages: [
      {
        content: task.prompt,
        role: "user",
      },
    ],
    agentLoopStrategy: maxIterations(5),
    ...systemPromptsPatch({
      caching,
      model,
      system: getSurfaceSystem(surface),
    }),
    modelOptions: mergeGenerationOptions({
      caching,
      model,
      maxOutputTokens: 500,
      serviceTier: "standard",
      temperature: 0,
    }),
    tools: getSurfaceTools({
      surface,
      trace,
    }),
  });

  let finalText = "";
  let usage: TokenUsage | null = null;
  for await (const chunk of stream) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
      finalText += chunk.delta;
      continue;
    }
    if (chunk.type === EventType.RUN_FINISHED) {
      usage = chunk.usage ?? null;
    }
  }

  const latencyMs = Math.round(performance.now() - start);

  return {
    finalText,
    repeat,
    score: scoreRun({
      latencyMs,
      surface,
      task,
      text: finalText,
      trace,
    }),
    surface,
    taskId: task.id,
    tools: trace.tools,
    usage,
  };
};

const selectedSurfaces = (surface: Surface | "all") => {
  if (surface === "all") {
    return surfaces;
  }

  return [surface];
};

const yesNo = (value: boolean) => (value ? "yes" : "no");

const renderRunTable = (runs: readonly BenchRun[]) => {
  const rows = [
    "| surface | task | pass | right surface | shape err | ns err | catalog | tools | ms |",
    "| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |",
  ];

  for (const run of runs) {
    rows.push(
      [
        `| ${run.surface}`,
        run.taskId,
        yesNo(run.score.passed),
        yesNo(run.score.rightSurface),
        yesNo(run.score.shapeError),
        yesNo(run.score.wrongNamespace),
        String(run.score.catalogCalls),
        String(run.score.toolCalls),
        `${run.score.latencyMs} |`,
      ].join(" | "),
    );
  }

  return rows.join("\n");
};

const average = (values: readonly number[]) => {
  if (values.length === 0) {
    return 0;
  }

  let total = 0;
  for (const value of values) {
    total += value;
  }

  return total / values.length;
};

const percent = (part: number, total: number) => {
  if (total === 0) {
    return "0%";
  }

  return `${Math.round((part / total) * 100)}%`;
};

const renderSummary = (runs: readonly BenchRun[]) => {
  const rows = [
    "| surface | pass rate | failed tools | shape err | ns err | avg catalog | avg tools |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const surface of surfaces) {
    const surfaceRuns = runs.filter((run) => run.surface === surface);
    if (surfaceRuns.length === 0) {
      continue;
    }

    const passed = surfaceRuns.filter((run) => run.score.passed).length;
    const shapeErrors = surfaceRuns.filter(
      (run) => run.score.shapeError,
    ).length;
    const failedTools = surfaceRuns.filter(
      (run) => run.score.failedToolCalls > 0,
    ).length;
    const namespaceErrors = surfaceRuns.filter(
      (run) => run.score.wrongNamespace,
    ).length;

    rows.push(
      [
        `| ${surface}`,
        percent(passed, surfaceRuns.length),
        percent(failedTools, surfaceRuns.length),
        percent(shapeErrors, surfaceRuns.length),
        percent(namespaceErrors, surfaceRuns.length),
        average(surfaceRuns.map((run) => run.score.catalogCalls)).toFixed(1),
        `${average(surfaceRuns.map((run) => run.score.toolCalls)).toFixed(1)} |`,
      ].join(" | "),
    );
  }

  return rows.join("\n");
};

const main = async () => {
  const args = parseArgs();
  const benchModel = await getBenchModel();

  if (!benchModel) {
    console.log(
      "No instance AI provider is configured. Set AI_PROVIDER plus the matching key, or set one provider key, then rerun.",
    );
    return;
  }

  console.log(
    `Running chat read-surface benchmark with ${benchModel.provider}/${benchModel.id}.`,
  );
  console.log(
    `Surfaces: ${selectedSurfaces(args.surface).join(", ")}. Repeats: ${args.repeats}.`,
  );

  const runs: BenchRun[] = [];
  for (let repeat = 1; repeat <= args.repeats; repeat++) {
    for (const surface of selectedSurfaces(args.surface)) {
      for (const task of tasks) {
        runs.push(
          // oxlint-disable-next-line no-await-in-loop -- sequential benchmark runs; parallelism would distort per-task timings
          await runBenchTask({
            model: benchModel.model,
            repeat,
            surface,
            task,
          }),
        );
      }
    }
  }

  console.log("");
  console.log(renderSummary(runs));
  console.log("");
  console.log(renderRunTable(runs));

  if (args.json) {
    console.log("");
    console.log(
      JSON.stringify(
        {
          model: {
            id: benchModel.id,
            provider: benchModel.provider,
          },
          runs,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log("Use --json for full per-run tool traces and usage.");
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark failed: ${message}`);
  process.exitCode = 1;
});
