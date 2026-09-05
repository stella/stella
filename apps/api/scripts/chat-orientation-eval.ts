/**
 * Chat orientation benchmark: can a (weak) model complete simple workspace
 * tasks through Stella's chat without tool-call failures?
 *
 * The script signs in with the dev OTP flow, creates a dedicated eval matter
 * with known contents (2 documents, 2 tasks, and an extracted "Change of
 * control" text column with a value on each document), runs a fixed set of
 * orientation prompts in fresh chat threads, and scores each turn from the
 * persisted assistant message parts (tool-call counts, terminal tool states,
 * expected names in the final text, and for task 5 the absence of
 * content-search tool calls: the extracted column already answers the
 * question, so a preference-respecting model must not fall back to
 * search_across_matters / read_content_across_matters).
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
 * Before running, --models entries whose model id looks like an OpenRouter
 * slug (contains "/") are validated against the public OpenRouter catalog
 * (https://openrouter.ai/api/v1/models): models not listed, or listed without
 * "tools" in supported_parameters, are skipped with a warning and reported
 * with outcome `unsupported`. When the catalog fetch fails, validation is
 * skipped with a warning and every model runs.
 *
 * Each turn is scored to one of four outcomes:
 *   pass         all scoring checks passed
 *   fail         at least one scoring check failed
 *   no-response  zero tool calls and empty final text; signals a
 *                provider/adapter incompatibility rather than an
 *                orientation failure (still counts against the pass rate)
 *   unsupported  model skipped by OpenRouter pre-validation
 *
 * Flags:
 *   --api <url>          API base URL (default http://localhost:3001)
 *   --web-origin <url>   Origin header for better-auth (default http://localhost:3000)
 *   --email <email>      Sign-in email (default test@stella.dev)
 *   --models <a,b,c>     Comma-separated devModelId list; omit for one
 *                        pass with the org default model
 *   --json <path>        Write the full result object as JSON
 *   --task <n>           Run only benchmark task n (1-based)
 *   --runs <n>           Run each task n times, each in a fresh thread
 *                        (default 1); the report shows passes/N per task
 *   --pass-threshold <p> Minimum per-task pass rate in (0, 1] required for
 *                        exit code 0 (default 1.0)
 *   --keep               Keep the eval matter instead of deleting it
 *
 * Exit code 0 when every (model, task) pass rate meets --pass-threshold;
 * unsupported (skipped) models are reported and do not affect the exit code,
 * except when pre-validation skips every requested model: with nothing left
 * to run the script exits 1 without touching the API.
 */

const DEFAULT_API_BASE = "http://localhost:3001";
const DEFAULT_WEB_ORIGIN = "http://localhost:3000";
const DEFAULT_EMAIL = "test@stella.dev";
const API_VERSION_PREFIX = "/v1";

/** Matches DEFAULT_FILE_PROPERTY_NAME in apps/web/src/lib/workspaces/mutations.ts. */
const FILE_PROPERTY_NAME = "Documents";
/** Web default send mode fallback (resolveChatRequestSendMode); raw keeps
 * fixture names intact so text scoring is not confounded by anonymization. */
const SEND_MODE = "rawOverride";

const UNRESOLVED_REF_SENTINEL = "#stella-unresolved-ref";
const REDACTION_MARKER = "[internal-id-removed]";

const CRUD_TIMEOUT_MS = 20_000;
const CHAT_STREAM_TIMEOUT_MS = 300_000;

/** Public OpenRouter catalog used to pre-validate slug-shaped --models entries. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_FETCH_TIMEOUT_MS = 15_000;

const DEFAULT_RUNS = 1;
const DEFAULT_PASS_THRESHOLD = 1;

type CliOptions = {
  apiBase: string;
  webOrigin: string;
  email: string;
  models: string[];
  jsonPath: string | null;
  taskFilter: number | null;
  runs: number;
  passThreshold: number;
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
  /** Extracted text column; docAlpha holds "Yes", docBeta holds "No". */
  changeOfControlPropertyName: string;
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
  /** Anti-parroting floor. Tasks whose prompt contains the expected name
   * (task 3) are gameable by echoing it back without touching the
   * workspace, so a turn with fewer tool calls than this fails with
   * "answered without reading". */
  minToolCalls?: number;
  /** Tool names the turn must not use. Persisted `tool-call` parts carry the
   * tool `name` and its serialized `arguments` string (CHAT_PART_VALIDATORS
   * in apps/api/src/handlers/chat/chat-message-parts.ts), so a direct call
   * is caught by its part name and a code-mode call by the
   * `external_<name>(...)` invocation inside the `execute_typescript`
   * arguments (the model-written source code). Scoring therefore substring-
   * matches each forbidden name against "<name> <arguments>" per tool call;
   * when a tool part carries no recoverable name the check is skipped with
   * a note instead of failing. */
  notCalledToolNames?: readonly string[];
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
    // The prompt itself contains the expected document name, so the text
    // check alone is gameable by parroting; require at least one read.
    minToolCalls: 1,
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
  {
    index: 5,
    label: "extracted-data-first",
    // Deliberately no "answer from the extracted review data" hint: the task
    // measures whether the model prefers the existing extracted column over
    // running its own content search, not instruction-following.
    buildPrompt: () =>
      "Which documents in this matter have a change of control clause?",
    contextScope: "matter",
    // Only the Yes-document is asserted. The No-document may legitimately
    // appear in a correct answer ("Beta has no such clause"), so its
    // presence in the text is not a reliable failure signal.
    expected: (fixture) => [fixture.docAlphaName],
    maxToolCalls: 5,
    notCalledToolNames: [
      "search_across_matters",
      "read_content_across_matters",
    ],
  },
];

type TaskScore = {
  toolCalls: number;
  toolErrors: number;
  unresolvedRefSentinels: number;
  redactionMarkers: number;
  missingExpected: string[];
  /** Forbidden tool names (task.notCalledToolNames) the turn used anyway. */
  forbiddenToolUses: string[];
};

/** Result-column rendering per outcome; the union derives from this map. */
const TASK_OUTCOME_DISPLAY = {
  pass: "PASS",
  fail: "FAIL",
  "no-response": "no-response",
  unsupported: "unsupported",
} as const;

type TaskOutcome = keyof typeof TASK_OUTCOME_DISPLAY;

/** Outcomes produced by actually running a turn (everything but the
 * pre-validation skip). */
type ExecutedOutcome = Exclude<TaskOutcome, "unsupported">;

type TaskResult =
  | {
      /** Model skipped by OpenRouter pre-validation; the turn never ran. */
      outcome: "unsupported";
      taskIndex: number;
      taskLabel: string;
      model: string;
      notes: string[];
    }
  | {
      outcome: ExecutedOutcome;
      taskIndex: number;
      taskLabel: string;
      model: string | null;
      /** 1-based repeat index within --runs. */
      run: number;
      score: TaskScore;
      notes: string[];
      finalText: string;
    };

/** Per (model, task) pass rate over --runs repeats; unsupported rows are
 * excluded (those models never ran). */
type TaskAggregate = {
  taskIndex: number;
  taskLabel: string;
  model: string | null;
  passes: number;
  runs: number;
  passRate: number;
};

type EvalRunReport = {
  startedAt: string;
  apiBase: string;
  email: string;
  runs: number;
  passThreshold: number;
  fixture: Fixture | null;
  results: TaskResult[];
  aggregates: TaskAggregate[];
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
    runs: DEFAULT_RUNS,
    passThreshold: DEFAULT_PASS_THRESHOLD,
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
      case "--runs": {
        const raw = takeValue(flag, index);
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new EvalHarnessError(
            `--runs expects a positive integer, got "${raw}"`,
          );
        }
        options.runs = parsed;
        index += 1;
        break;
      }
      case "--pass-threshold": {
        const raw = takeValue(flag, index);
        const parsed = Number.parseFloat(raw);
        if (Number.isNaN(parsed) || parsed <= 0 || parsed > 1) {
          throw new EvalHarnessError(
            `--pass-threshold expects a number in (0, 1], got "${raw}"`,
          );
        }
        options.passThreshold = parsed;
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
// Model pre-validation against the OpenRouter catalog
// ---------------------------------------------------------------------------

/** devModelId entries take `provider::modelId` or bare-id form; only a
 * modelId containing "/" looks like an OpenRouter slug worth validating. */
const openRouterSlugOf = (model: string): string | null => {
  const separator = model.indexOf("::");
  const modelId = separator === -1 ? model : model.slice(separator + 2);
  return modelId.includes("/") ? modelId : null;
};

/** Map of OpenRouter model id to whether it lists "tools" in
 * supported_parameters, or null when the catalog could not be fetched
 * (validation is then skipped with a warning). */
const fetchOpenRouterToolSupport = async (): Promise<Map<
  string,
  boolean
> | null> => {
  const warnSkip = (reason: string): null => {
    console.warn(`OpenRouter model validation skipped: ${reason}`);
    return null;
  };

  const response = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(OPENROUTER_FETCH_TIMEOUT_MS),
  }).catch(String);
  if (typeof response === "string") {
    return warnSkip(response);
  }
  if (!response.ok) {
    return warnSkip(`catalog fetch returned ${response.status}`);
  }
  const payload: unknown = await response.json().catch(String);
  if (!isRecord(payload)) {
    return warnSkip("catalog response is not a JSON object");
  }
  const data = payload["data"];
  if (!Array.isArray(data)) {
    return warnSkip("catalog response has no data array");
  }

  const toolSupport = new Map<string, boolean>();
  for (const entry of data) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = getString(entry, "id");
    if (id === undefined) {
      continue;
    }
    const supportedParameters = entry["supported_parameters"];
    toolSupport.set(
      id,
      Array.isArray(supportedParameters) &&
        supportedParameters.includes("tools"),
    );
  }
  return toolSupport;
};

type PartitionedModels = {
  /** Models to actually run (null = org default pass). */
  runnable: (string | null)[];
  /** OpenRouter-slug models skipped by pre-validation, with the reason. */
  unsupported: { model: string; reason: string }[];
};

const partitionModelsByToolSupport = async (
  models: (string | null)[],
): Promise<PartitionedModels> => {
  const needsValidation = models.some(
    (model) => model !== null && openRouterSlugOf(model) !== null,
  );
  const toolSupport = needsValidation
    ? await fetchOpenRouterToolSupport()
    : null;

  const partitioned: PartitionedModels = { runnable: [], unsupported: [] };
  for (const model of models) {
    const slug = model === null ? null : openRouterSlugOf(model);
    if (model === null || slug === null || toolSupport === null) {
      partitioned.runnable.push(model);
      continue;
    }
    const supportsTools = toolSupport.get(slug);
    if (supportsTools === undefined) {
      partitioned.unsupported.push({
        model,
        reason: "not listed in the OpenRouter catalog",
      });
    } else if (supportsTools) {
      partitioned.runnable.push(model);
    } else {
      partitioned.unsupported.push({
        model,
        reason: 'missing "tools" in supported_parameters',
      });
    }
  }
  return partitioned;
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
    body: { kind, name },
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

/** PUT /v1/properties/:workspaceId (apps/api/src/handlers/properties/create.ts).
 * A manual-input text column keeps the fixture free of select-option shapes. */
const createTextProperty = async (
  client: ApiClient,
  matterId: string,
  name: string,
): Promise<string> => {
  const payload = await client.requestJson({
    method: "PUT",
    path: `${API_VERSION_PREFIX}/properties/${matterId}`,
    body: {
      name,
      contentType: "text",
      toolType: "manual-input",
    },
  });
  const propertyId = isRecord(payload) ? getString(payload, "id") : undefined;
  if (propertyId === undefined) {
    throw new EvalHarnessError(`Property create for "${name}" returned no id`);
  }
  return propertyId;
};

/** POST /v1/fields/:workspaceId (apps/api/src/handlers/fields/upsert-by-id.ts):
 * sets one cell (entity x property) of the matter table. */
const setTextField = async ({
  client,
  matterId,
  propertyId,
  entityId,
  value,
}: {
  client: ApiClient;
  matterId: string;
  propertyId: string;
  entityId: string;
  value: string;
}): Promise<void> => {
  await client.requestJson({
    method: "POST",
    path: `${API_VERSION_PREFIX}/fields/${matterId}`,
    body: {
      propertyId,
      entityId,
      content: { version: 1, type: "text", value },
    },
  });
};

const createFixture = async (client: ApiClient): Promise<Fixture> => {
  const runId = shortRunId();
  const matterId = Bun.randomUUIDv7();
  const matterName = `Eval Bench ${runId}`;

  await client.requestJson({
    method: "PUT",
    path: `${API_VERSION_PREFIX}/workspaces`,
    body: {
      id: matterId,
      name: matterName,
      filePropertyName: FILE_PROPERTY_NAME,
    },
  });

  const docAlphaName = `EvalDoc Alpha ${runId}`;
  const docBetaName = `EvalDoc Beta ${runId}`;
  const taskOneName = `EvalTask One ${runId}`;
  const taskTwoName = `EvalTask Two ${runId}`;

  const docAlphaId = await createEntity(
    client,
    matterId,
    "document",
    docAlphaName,
  );
  const docBetaId = await createEntity(
    client,
    matterId,
    "document",
    docBetaName,
  );
  const entityIds = [
    docAlphaId,
    docBetaId,
    await createEntity(client, matterId, "task", taskOneName),
    await createEntity(client, matterId, "task", taskTwoName),
  ];

  // Extracted review column for task 5: the answer to "which documents have
  // a change of control clause" already sits in the table, so the model has
  // no reason to run a content search.
  const changeOfControlPropertyName = `Change of control ${runId}`;
  const propertyId = await createTextProperty(
    client,
    matterId,
    changeOfControlPropertyName,
  );
  await setTextField({
    client,
    matterId,
    propertyId,
    entityId: docAlphaId,
    value: "Yes",
  });
  await setTextField({
    client,
    matterId,
    propertyId,
    entityId: docBetaId,
    value: "No",
  });

  return {
    runId,
    matterId,
    matterName,
    docAlphaName,
    docBetaName,
    taskOneName,
    taskTwoName,
    changeOfControlPropertyName,
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
  /** One "<name> <arguments>" entry per tool-call part whose name was
   * recoverable; the arguments string covers code-mode, where the external
   * tool invocations live inside the execute_typescript source code. */
  toolCallSignatures: string[];
  /** False when any tool-call part carried no recoverable name, so
   * notCalledToolNames checks must be skipped rather than trusted. */
  toolNamesRecoverable: boolean;
};

const isToolCallPartType = (type: string): boolean =>
  type === "tool-call" ||
  type === "dynamic-tool" ||
  (type.startsWith("tool-") && type !== "tool-result");

const toolCallPartName = (
  part: Record<string, unknown>,
  type: string,
): string | undefined => {
  // Persisted TanStack tool-call parts use `name`; dynamic-tool parts use
  // `toolName`; legacy `tool-<name>` part types encode the name in the type.
  const name = getString(part, "name") ?? getString(part, "toolName");
  if (name !== undefined) {
    return name;
  }
  if (type.startsWith("tool-") && type !== "tool-call") {
    return type.slice("tool-".length);
  }
  return undefined;
};

const parseAssistantTurn = (messagesPayload: unknown): ParsedAssistantTurn => {
  const turn: ParsedAssistantTurn = {
    text: "",
    toolCalls: 0,
    toolErrors: 0,
    toolCallSignatures: [],
    toolNamesRecoverable: true,
  };
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
        const toolName = toolCallPartName(part, type);
        if (toolName === undefined) {
          turn.toolNamesRecoverable = false;
        } else {
          turn.toolCallSignatures.push(
            `${toolName} ${getString(part, "arguments") ?? ""}`,
          );
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
  run,
}: {
  client: ApiClient;
  fixture: Fixture;
  task: BenchTask;
  model: string | null;
  /** 1-based repeat index within --runs. */
  run: number;
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
      // Matter-pinned tasks mirror the UI's matter chat, which binds the
      // thread to the workspace: `workspaceId` is what renders the
      // connected-matter prompt section (extracted properties included),
      // while `contextMatterIds` scopes tool authorization.
      ...(task.contextScope === "matter"
        ? { workspaceId: fixture.matterId }
        : {}),
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

  let turn: ParsedAssistantTurn = {
    text: "",
    toolCalls: 0,
    toolErrors: 0,
    toolCallSignatures: [],
    toolNamesRecoverable: true,
  };
  if (streamResponse.ok) {
    const messagesPayload = await client.requestJson({
      method: "GET",
      // A workspace-bound thread's scope must match the request, so
      // matter-pinned tasks pass the workspace id along.
      path:
        task.contextScope === "matter"
          ? `${API_VERSION_PREFIX}/chat/threads/${threadId}/messages?workspaceId=${fixture.matterId}`
          : `${API_VERSION_PREFIX}/chat/threads/${threadId}/messages`,
    });
    turn = parseAssistantTurn(messagesPayload);
  }

  const finalTextLower = turn.text.toLowerCase();
  const missingExpected = task
    .expected(fixture)
    .filter((name) => !finalTextLower.includes(name.toLowerCase()));

  const forbiddenToolUses: string[] = [];
  if (task.notCalledToolNames !== undefined && turn.toolCalls > 0) {
    if (turn.toolNamesRecoverable) {
      for (const forbidden of task.notCalledToolNames) {
        if (
          turn.toolCallSignatures.some((signature) =>
            signature.includes(forbidden),
          )
        ) {
          forbiddenToolUses.push(forbidden);
        }
      }
    } else {
      notes.push(
        "tool names not recoverable from persisted parts; " +
          "notCalledToolNames check skipped",
      );
    }
  }

  const score: TaskScore = {
    toolCalls: turn.toolCalls,
    toolErrors: turn.toolErrors,
    unresolvedRefSentinels: countOccurrences(
      turn.text,
      UNRESOLVED_REF_SENTINEL,
    ),
    redactionMarkers: countOccurrences(turn.text, REDACTION_MARKER),
    missingExpected,
    forbiddenToolUses,
  };

  // Zero tool calls plus an empty final answer is a distinct outcome: the
  // adapter produced nothing, which signals a provider/adapter
  // incompatibility rather than an orientation failure.
  const noResponse =
    streamResponse.ok && turn.toolCalls === 0 && turn.text.trim().length === 0;
  if (noResponse) {
    notes.push(
      `no tool calls and empty final text from ${model ?? "the org default model"}; ` +
        "likely a provider/adapter incompatibility, not an orientation failure",
    );
  }

  const belowMinToolCalls =
    task.minToolCalls !== undefined && turn.toolCalls < task.minToolCalls;
  if (belowMinToolCalls && !noResponse) {
    notes.push(
      `answered without reading (${turn.toolCalls} tool call(s) < min ${task.minToolCalls})`,
    );
  }

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
  if (score.forbiddenToolUses.length > 0) {
    notes.push(`used forbidden tool(s): ${score.forbiddenToolUses.join(", ")}`);
  }

  const pass =
    streamResponse.ok &&
    !belowMinToolCalls &&
    missingExpected.length === 0 &&
    score.toolErrors === 0 &&
    score.toolCalls <= task.maxToolCalls &&
    score.forbiddenToolUses.length === 0 &&
    // A redaction marker or unresolved ref sentinel reaching the persisted
    // assistant text is always a production defect (leaked placeholder or a
    // hallucinated ref), never a legitimate answer, so either fails the task.
    score.unresolvedRefSentinels === 0 &&
    score.redactionMarkers === 0;

  const executedOutcome = (): ExecutedOutcome => {
    if (noResponse) {
      return "no-response";
    }
    return pass ? "pass" : "fail";
  };

  return {
    outcome: executedOutcome(),
    taskIndex: task.index,
    taskLabel: task.label,
    model,
    run,
    score,
    notes,
    finalText: turn.text,
  };
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const printTable = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
): void => {
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

const printResultsTable = (results: readonly TaskResult[]): void => {
  const header = [
    "task",
    "model",
    "run",
    "result",
    "toolCalls",
    "toolErrors",
    "notes",
  ];
  const rows = results.map((result) =>
    result.outcome === "unsupported"
      ? [
          `${result.taskIndex} ${result.taskLabel}`,
          result.model,
          "-",
          TASK_OUTCOME_DISPLAY[result.outcome],
          "-",
          "-",
          result.notes.join("; ") || "-",
        ]
      : [
          `${result.taskIndex} ${result.taskLabel}`,
          result.model ?? "(org default)",
          String(result.run),
          TASK_OUTCOME_DISPLAY[result.outcome],
          String(result.score.toolCalls),
          String(result.score.toolErrors),
          result.notes.join("; ") || "-",
        ],
  );
  printTable(header, rows);
};

const printAggregateTable = (aggregates: readonly TaskAggregate[]): void => {
  const header = ["task", "model", "passes", "passRate"];
  const rows = aggregates.map((aggregate) => [
    `${aggregate.taskIndex} ${aggregate.taskLabel}`,
    aggregate.model ?? "(org default)",
    `${aggregate.passes}/${aggregate.runs}`,
    aggregate.passRate.toFixed(2),
  ]);
  printTable(header, rows);
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

  const startedAt = new Date().toISOString();
  const models: (string | null)[] =
    options.models.length > 0 ? options.models : [null];
  const { runnable, unsupported } = await partitionModelsByToolSupport(models);

  const results: TaskResult[] = [];
  for (const { model, reason } of unsupported) {
    console.warn(`Skipping ${model}: ${reason}`);
    for (const task of tasks) {
      results.push({
        outcome: "unsupported",
        taskIndex: task.index,
        taskLabel: task.label,
        model,
        notes: [reason],
      });
    }
  }

  const writeJsonReport = async (report: EvalRunReport): Promise<void> => {
    if (options.jsonPath === null) {
      return;
    }
    await Bun.write(options.jsonPath, JSON.stringify(report, null, 2));
    console.log(`\nWrote JSON report to ${options.jsonPath}`);
  };

  if (runnable.length === 0) {
    console.log("");
    printResultsTable(results);
    await writeJsonReport({
      startedAt,
      apiBase: options.apiBase,
      email: options.email,
      runs: options.runs,
      passThreshold: options.passThreshold,
      fixture: null,
      results,
      aggregates: [],
      allPassed: false,
    });
    console.log("\nEvery model was skipped by pre-validation (exit 1).");
    process.exit(1);
  }

  console.log(`Signing in as ${options.email} at ${options.apiBase} ...`);
  await signIn(client, options.email);

  console.log("Creating eval fixture ...");
  const fixture = await createFixture(client);
  console.log(
    `Fixture ready: ${fixture.matterName} (${fixture.matterId}), ` +
      `${fixture.entityIds.length} entities`,
  );

  try {
    for (const model of runnable) {
      for (const task of tasks) {
        for (let run = 1; run <= options.runs; run += 1) {
          console.log(
            `Running task ${task.index} (${task.label}) ` +
              `run ${run}/${options.runs} with ` +
              `${model ?? "org default model"} ...`,
          );
          const result = await runBenchTask({
            client,
            fixture,
            task,
            model,
            run,
          });
          results.push(result);
        }
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

  const aggregates: TaskAggregate[] = [];
  for (const model of runnable) {
    for (const task of tasks) {
      const taskResults = results.filter(
        (result) =>
          result.outcome !== "unsupported" &&
          result.model === model &&
          result.taskIndex === task.index,
      );
      const passes = taskResults.filter(
        (result) => result.outcome === "pass",
      ).length;
      aggregates.push({
        taskIndex: task.index,
        taskLabel: task.label,
        model,
        passes,
        runs: taskResults.length,
        passRate: taskResults.length === 0 ? 0 : passes / taskResults.length,
      });
    }
  }

  console.log("");
  printResultsTable(results);
  console.log("");
  printAggregateTable(aggregates);

  const allPassed = aggregates.every(
    (aggregate) => aggregate.passRate >= options.passThreshold,
  );
  await writeJsonReport({
    startedAt,
    apiBase: options.apiBase,
    email: options.email,
    runs: options.runs,
    passThreshold: options.passThreshold,
    fixture,
    results,
    aggregates,
    allPassed,
  });

  console.log(
    allPassed
      ? `\nAll tasks met the pass threshold (${options.passThreshold}).`
      : `\nSome tasks fell below the pass threshold ${options.passThreshold} (exit 1).`,
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
