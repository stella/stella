/**
 * Chat orientation benchmark: can a (weak) model complete simple workspace
 * tasks through Stella's chat without tool-call failures?
 *
 * The script signs in with the dev OTP flow, creates a dedicated eval matter
 * with known contents (2 documents, 2 tasks), runs a fixed set of orientation
 * prompts in fresh chat threads, and scores each turn from the persisted
 * assistant message parts (tool-call counts, terminal tool states, expected
 * names in the final text).
 *
 * Prerequisites:
 *  - Local dev stack running: `bun run dev` (API on 3001, web origin 3000).
 *  - Seeded test user: `bun --filter @stll/api db:seed-test-user`
 *    (default email test@stella.dev, override with --email).
 *  - The OTP is read from the dev-only endpoint `GET /dev-public/last-otp`,
 *    so this only works against a dev API.
 *
 * Usage:
 *   bun apps/api/scripts/chat-orientation-eval.ts
 *     One pass with no model override: the org default resolves, which is
 *     the mock AI adapter when USE_MOCK_AI="true" (the dev default).
 *
 *   bun apps/api/scripts/chat-orientation-eval.ts \
 *     --models openai::gpt-4.1-nano,anthropic::claude-3-5-haiku-latest
 *     One pass per model via the dev-only `devModelId` body field.
 *
 * devModelId constraints (see validateTanStackDevModelOverride in
 * apps/api/src/lib/tanstack-ai-models.ts):
 *  - Rejected outside dev (env.isDev must be true).
 *  - Charset [A-Za-z0-9._:/-], max length 160.
 *  - `provider::modelId` form: the provider must be TanStack-supported and
 *    configured for the active org (or have instance credentials when the
 *    org has no AI config); azure_foundry / openai_compatible are rejected.
 *  - A bare id (no known `provider::` prefix) skips provider validation and
 *    resolves against the default provider chain.
 *
 * Flags:
 *   --api <url>         API base URL (default http://localhost:3001)
 *   --web-origin <url>  Origin header for better-auth (default http://localhost:3000)
 *   --email <email>     Sign-in email (default test@stella.dev)
 *   --models <a,b,c>    Comma-separated devModelId list; omit for one
 *                       pass with the org default model
 *   --json <path>       Write the full result object as JSON
 *   --task <n>          Run only benchmark task n (1-based)
 *   --keep              Keep the eval matter instead of deleting it
 *
 * Exit code 0 when every task passes, 1 otherwise.
 */

const DEFAULT_API_BASE = "http://localhost:3001";
const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
const DEFAULT_EMAIL = "test@stella.dev";
const API_VERSION_PREFIX = "/v1";

/** Matches DEFAULT_FILE_PROPERTY_NAME in apps/web/src/lib/workspaces/mutations.ts. */
const FILE_PROPERTY_NAME = "Documents";
/** invalidateQuery-macro routes require a non-empty queryKey in the body. */
const INVALIDATE_QUERY_KEY = ["chat-orientation-eval"];
/** Web default send mode fallback (resolveChatRequestSendMode); raw keeps
 * fixture names intact so text scoring is not confounded by anonymization. */
const SEND_MODE = "rawOverride";

const UNRESOLVED_REF_SENTINEL = "#stella-unresolved-ref";
const REDACTION_MARKER = "[internal-id-removed]";

const CRUD_TIMEOUT_MS = 20_000;
const CHAT_STREAM_TIMEOUT_MS = 300_000;

type CliOptions = {
  apiBase: string;
  webOrigin: string;
  email: string;
  models: string[];
  jsonPath: string | null;
  taskFilter: number | null;
  keep: boolean;
};

type Fixture = {
  runId: string;
  matterId: string;
  matterName: string;
  docAlphaName: string;
  docBetaName: string;
  taskOneName: string;
  taskTwoName: string;
  entityIds: string[];
};

type BenchTask = {
  index: number;
  label: string;
  buildPrompt: (fixture: Fixture) => string;
  /** "matter" pins the eval matter via contextMatterIds; "none" sends an
   * empty list so the model must discover the matter itself. */
  contextScope: "matter" | "none";
  expected: (fixture: Fixture) => string[];
  maxToolCalls: number;
};

const BENCH_TASKS: readonly BenchTask[] = [
  {
    index: 1,
    label: "list-everything",
    buildPrompt: () =>
      "List everything in this matter — documents, tasks, and contacts.",
    contextScope: "matter",
    expected: (fixture) => [
      fixture.docAlphaName,
      fixture.docBetaName,
      fixture.taskOneName,
      fixture.taskTwoName,
    ],
    maxToolCalls: 6,
  },
  {
    index: 2,
    label: "open-tasks",
    buildPrompt: () => "What tasks are open in this matter?",
    contextScope: "matter",
    expected: (fixture) => [fixture.taskOneName, fixture.taskTwoName],
    maxToolCalls: 4,
  },
  {
    index: 3,
    label: "find-document",
    buildPrompt: (fixture) =>
      `Does this matter contain a document called '${fixture.docAlphaName}'?`,
    contextScope: "matter",
    expected: (fixture) => [fixture.docAlphaName],
    maxToolCalls: 4,
  },
  {
    index: 4,
    label: "discover-matter",
    buildPrompt: (fixture) =>
      `List the documents in the matter named exactly '${fixture.matterName}'.`,
    contextScope: "none",
    expected: (fixture) => [fixture.docAlphaName, fixture.docBetaName],
    maxToolCalls: 6,
  },
];

type TaskScore = {
  toolCalls: number;
  toolErrors: number;
  unresolvedRefSentinels: number;
  redactionMarkers: number;
  missingExpected: string[];
};

type TaskResult = {
  taskIndex: number;
  taskLabel: string;
  model: string | null;
  pass: boolean;
  score: TaskScore;
  notes: string[];
  finalText: string;
};

type EvalRunReport = {
  startedAt: string;
  apiBase: string;
  email: string;
  fixture: Fixture;
  results: TaskResult[];
  allPassed: boolean;
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

const shortRunId = (): string =>
  Math.random().toString(36).slice(2, 8).padEnd(6, "0");

class EvalHarnessError extends Error {
  override name = "EvalHarnessError";
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const parseCliOptions = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    apiBase: DEFAULT_API_BASE,
    webOrigin: DEFAULT_WEB_ORIGIN,
    email: DEFAULT_EMAIL,
    models: [],
    jsonPath: null,
    taskFilter: null,
    keep: false,
  };

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new EvalHarnessError(`Flag ${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) {
      continue;
    }
    switch (flag) {
      case "--api":
        options.apiBase = takeValue(flag, index).replace(/\/$/u, "");
        index += 1;
        break;
      case "--web-origin":
        options.webOrigin = takeValue(flag, index).replace(/\/$/u, "");
        index += 1;
        break;
      case "--email":
        options.email = takeValue(flag, index);
        index += 1;
        break;
      case "--models":
        options.models = takeValue(flag, index)
          .split(",")
          .map((model) => model.trim())
          .filter((model) => model.length > 0);
        index += 1;
        break;
      case "--json":
        options.jsonPath = takeValue(flag, index);
        index += 1;
        break;
      case "--task": {
        const raw = takeValue(flag, index);
        const parsed = Number.parseInt(raw, 10);
        if (Number.isNaN(parsed)) {
          throw new EvalHarnessError(`--task expects a number, got "${raw}"`);
        }
        options.taskFilter = parsed;
        index += 1;
        break;
      }
      case "--keep":
        options.keep = true;
        break;
      default:
        throw new EvalHarnessError(`Unknown flag: ${flag}`);
    }
  }

  return options;
};

// ---------------------------------------------------------------------------
// HTTP client (cookie jar + origin header on every request)
// ---------------------------------------------------------------------------

type ApiClient = {
  request: (options: {
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }) => Promise<Response>;
  requestJson: (options: {
    method: string;
    path: string;
    body?: unknown;
    timeoutMs?: number;
  }) => Promise<unknown>;
};

const createApiClient = (apiBase: string, webOrigin: string): ApiClient => {
  const cookieJar = new Map<string, string>();

  const absorbCookies = (response: Response): void => {
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";").at(0);
      if (pair === undefined) {
        continue;
      }
      const separator = pair.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      cookieJar.set(
        pair.slice(0, separator).trim(),
        pair.slice(separator + 1).trim(),
      );
    }
  };

  const request: ApiClient["request"] = async ({
    method,
    path,
    body,
    timeoutMs = CRUD_TIMEOUT_MS,
  }) => {
    const headers = new Headers({ origin: webOrigin });
    if (cookieJar.size > 0) {
      headers.set(
        "cookie",
        [...cookieJar.entries()]
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      );
    }
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    absorbCookies(response);
    return response;
  };

  const requestJson: ApiClient["requestJson"] = async (options) => {
    const response = await request(options);
    const text = await response.text();
    if (!response.ok) {
      throw new EvalHarnessError(
        `${options.method} ${options.path} failed with ${response.status}: ${text.slice(0, 400)}`,
      );
    }
    if (text.length === 0) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return parsed;
  };

  return { request, requestJson };
};

// ---------------------------------------------------------------------------
// Auth: dev OTP sign-in + active organization
// ---------------------------------------------------------------------------

const signIn = async (client: ApiClient, email: string): Promise<void> => {
  await client.requestJson({
    method: "POST",
    path: "/api/auth/email-otp/send-verification-otp",
    body: { email, type: "sign-in" },
  });

  const otpPayload = await client.requestJson({
    method: "GET",
    path: `/dev-public/last-otp?email=${encodeURIComponent(email)}`,
  });
  const otp = isRecord(otpPayload) ? getString(otpPayload, "otp") : undefined;
  if (otp === undefined) {
    throw new EvalHarnessError(
      "No OTP returned from /dev-public/last-otp; is the API running in dev mode?",
    );
  }

  await client.requestJson({
    method: "POST",
    path: "/api/auth/sign-in/email-otp",
    body: { email, otp },
  });

  const organizations = await client.requestJson({
    method: "GET",
    path: "/api/auth/organization/list",
  });
  if (!Array.isArray(organizations)) {
    throw new EvalHarnessError("organization/list did not return an array");
  }
  const firstOrganization = organizations.at(0);
  const organizationId = isRecord(firstOrganization)
    ? getString(firstOrganization, "id")
    : undefined;
  if (organizationId === undefined) {
    throw new EvalHarnessError(
      `No organization membership for ${DEFAULT_EMAIL}; run db:seed-test-user first`,
    );
  }

  await client.requestJson({
    method: "POST",
    path: "/api/auth/organization/set-active",
    body: { organizationId },
  });
};

// ---------------------------------------------------------------------------
// Fixture: eval matter + known entities
// ---------------------------------------------------------------------------

const createEntity = async (
  client: ApiClient,
  matterId: string,
  kind: "document" | "task",
  name: string,
): Promise<string> => {
  const payload = await client.requestJson({
    method: "PUT",
    path: `${API_VERSION_PREFIX}/entities/${matterId}`,
    body: { queryKey: INVALIDATE_QUERY_KEY, kind, name },
  });
  const entityId = isRecord(payload)
    ? getString(payload, "entityId")
    : undefined;
  if (entityId === undefined) {
    throw new EvalHarnessError(
      `Entity create for "${name}" returned no entityId`,
    );
  }
  return entityId;
};

const createFixture = async (client: ApiClient): Promise<Fixture> => {
  const runId = shortRunId();
  const matterId = Bun.randomUUIDv7();
  const matterName = `Eval Bench ${runId}`;

  await client.requestJson({
    method: "PUT",
    path: `${API_VERSION_PREFIX}/workspaces`,
    body: {
      queryKey: INVALIDATE_QUERY_KEY,
      id: matterId,
      name: matterName,
      filePropertyName: FILE_PROPERTY_NAME,
    },
  });

  const docAlphaName = `EvalDoc Alpha ${runId}`;
  const docBetaName = `EvalDoc Beta ${runId}`;
  const taskOneName = `EvalTask One ${runId}`;
  const taskTwoName = `EvalTask Two ${runId}`;

  const entityIds = [
    await createEntity(client, matterId, "document", docAlphaName),
    await createEntity(client, matterId, "document", docBetaName),
    await createEntity(client, matterId, "task", taskOneName),
    await createEntity(client, matterId, "task", taskTwoName),
  ];

  return {
    runId,
    matterId,
    matterName,
    docAlphaName,
    docBetaName,
    taskOneName,
    taskTwoName,
    entityIds,
  };
};

const deleteFixture = async (
  client: ApiClient,
  fixture: Fixture,
): Promise<void> => {
  await client.requestJson({
    method: "DELETE",
    path: `${API_VERSION_PREFIX}/workspaces/${fixture.matterId}`,
    body: { queryKey: INVALIDATE_QUERY_KEY },
  });
};

// ---------------------------------------------------------------------------
// Chat turn: send message, drain stream, score persisted parts
// ---------------------------------------------------------------------------

/** Persisted assistant parts relevant to scoring (see CHAT_PART_VALIDATORS in
 * apps/api/src/handlers/chat/chat-message-parts.ts). */
type ParsedAssistantTurn = {
  text: string;
  toolCalls: number;
  toolErrors: number;
};

const isToolCallPartType = (type: string): boolean =>
  type === "tool-call" ||
  type === "dynamic-tool" ||
  (type.startsWith("tool-") && type !== "tool-result");

const parseAssistantTurn = (messagesPayload: unknown): ParsedAssistantTurn => {
  const turn: ParsedAssistantTurn = { text: "", toolCalls: 0, toolErrors: 0 };
  if (!isRecord(messagesPayload)) {
    return turn;
  }
  const messages = messagesPayload["messages"];
  if (!Array.isArray(messages)) {
    return turn;
  }

  const textChunks: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message["role"] !== "assistant") {
      continue;
    }
    const parts = message["parts"];
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      const type = getString(part, "type");
      if (type === undefined) {
        continue;
      }
      if (type === "text") {
        // TanStack text parts carry `content`; tolerate legacy `text`.
        const content = getString(part, "content") ?? getString(part, "text");
        if (content !== undefined) {
          textChunks.push(content);
        }
        continue;
      }
      if (isToolCallPartType(type)) {
        turn.toolCalls += 1;
        if (getString(part, "state") === "error") {
          turn.toolErrors += 1;
        }
      }
    }
  }

  turn.text = textChunks.join("\n");
  return turn;
};

const runBenchTask = async ({
  client,
  fixture,
  task,
  model,
}: {
  client: ApiClient;
  fixture: Fixture;
  task: BenchTask;
  model: string | null;
}): Promise<TaskResult> => {
  const threadId = Bun.randomUUIDv7();
  const notes: string[] = [];

  const streamResponse = await client.request({
    method: "POST",
    path: `${API_VERSION_PREFIX}/chat`,
    timeoutMs: CHAT_STREAM_TIMEOUT_MS,
    body: {
      threadId,
      sendMode: SEND_MODE,
      contextMatterIds:
        task.contextScope === "matter" ? [fixture.matterId] : [],
      message: {
        id: Bun.randomUUIDv7(),
        role: "user",
        parts: [{ type: "text", content: task.buildPrompt(fixture) }],
      },
      ...(model === null ? {} : { devModelId: model }),
    },
  });

  // Drain the SSE stream fully so the turn persists; scoring reads the
  // persisted assistant message parts instead of parsing stream frames.
  const streamText = await streamResponse.text();
  if (!streamResponse.ok) {
    notes.push(
      `chat send failed with ${streamResponse.status}: ${streamText.slice(0, 200)}`,
    );
  }

  let turn: ParsedAssistantTurn = { text: "", toolCalls: 0, toolErrors: 0 };
  if (streamResponse.ok) {
    const messagesPayload = await client.requestJson({
      method: "GET",
      path: `${API_VERSION_PREFIX}/chat/threads/${threadId}/messages`,
    });
    turn = parseAssistantTurn(messagesPayload);
  }

  const finalTextLower = turn.text.toLowerCase();
  const missingExpected = task
    .expected(fixture)
    .filter((name) => !finalTextLower.includes(name.toLowerCase()));

  const score: TaskScore = {
    toolCalls: turn.toolCalls,
    toolErrors: turn.toolErrors,
    unresolvedRefSentinels: countOccurrences(
      turn.text,
      UNRESOLVED_REF_SENTINEL,
    ),
    redactionMarkers: countOccurrences(turn.text, REDACTION_MARKER),
    missingExpected,
  };

  if (missingExpected.length > 0) {
    notes.push(`missing: ${missingExpected.join(", ")}`);
  }
  if (score.toolErrors > 0) {
    notes.push(`${score.toolErrors} tool error(s)`);
  }
  if (score.toolCalls > task.maxToolCalls) {
    notes.push(`${score.toolCalls} tool calls > max ${task.maxToolCalls}`);
  }
  if (score.unresolvedRefSentinels > 0) {
    notes.push(`${score.unresolvedRefSentinels} unresolved ref(s)`);
  }
  if (score.redactionMarkers > 0) {
    notes.push(`${score.redactionMarkers} redaction marker(s)`);
  }

  const pass =
    streamResponse.ok &&
    missingExpected.length === 0 &&
    score.toolErrors === 0 &&
    score.toolCalls <= task.maxToolCalls;

  return {
    taskIndex: task.index,
    taskLabel: task.label,
    model,
    pass,
    score,
    notes,
    finalText: turn.text,
  };
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const printResultsTable = (results: readonly TaskResult[]): void => {
  const header = [
    "task",
    "model",
    "result",
    "toolCalls",
    "toolErrors",
    "notes",
  ];
  const rows = results.map((result) => [
    `${result.taskIndex} ${result.taskLabel}`,
    result.model ?? "(org default)",
    result.pass ? "PASS" : "FAIL",
    String(result.score.toolCalls),
    String(result.score.toolErrors),
    result.notes.join("; ") || "-",
  ]);

  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join("  ");

  console.log(formatRow(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(formatRow(row));
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const options = parseCliOptions(process.argv.slice(2));
  const client = createApiClient(options.apiBase, options.webOrigin);

  const tasks = BENCH_TASKS.filter(
    (task) => options.taskFilter === null || task.index === options.taskFilter,
  );
  if (tasks.length === 0) {
    throw new EvalHarnessError(
      `--task ${options.taskFilter} matches no benchmark task (1-${BENCH_TASKS.length})`,
    );
  }

  console.log(`Signing in as ${options.email} at ${options.apiBase} ...`);
  await signIn(client, options.email);

  console.log("Creating eval fixture ...");
  const fixture = await createFixture(client);
  console.log(
    `Fixture ready: ${fixture.matterName} (${fixture.matterId}), ` +
      `${fixture.entityIds.length} entities`,
  );

  const models: (string | null)[] =
    options.models.length > 0 ? options.models : [null];

  const results: TaskResult[] = [];
  try {
    for (const model of models) {
      for (const task of tasks) {
        console.log(
          `Running task ${task.index} (${task.label}) with ` +
            `${model ?? "org default model"} ...`,
        );
        // oxlint-disable-next-line no-await-in-loop -- benchmark turns run sequentially by design
        const result = await runBenchTask({ client, fixture, task, model });
        results.push(result);
      }
    }
  } finally {
    if (options.keep) {
      console.log(`--keep set; leaving matter ${fixture.matterId} in place`);
    } else {
      console.log("Deleting eval matter ...");
      await deleteFixture(client, fixture).catch((error: unknown) => {
        console.error(`Fixture cleanup failed: ${String(error)}`);
      });
    }
  }

  console.log("");
  printResultsTable(results);

  const allPassed = results.every((result) => result.pass);
  const report: EvalRunReport = {
    startedAt: new Date().toISOString(),
    apiBase: options.apiBase,
    email: options.email,
    fixture,
    results,
    allPassed,
  };

  if (options.jsonPath !== null) {
    await Bun.write(options.jsonPath, JSON.stringify(report, null, 2));
    console.log(`\nWrote JSON report to ${options.jsonPath}`);
  }

  console.log(
    allPassed ? "\nAll tasks passed." : "\nSome tasks failed (exit 1).",
  );
  process.exit(allPassed ? 0 : 1);
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    process.exit(1);
  });
}
