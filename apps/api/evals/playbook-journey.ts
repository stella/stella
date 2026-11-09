/**
 * Playbook journey: run a real playbook on real-shaped contracts with a real
 * model, from the matter table and from the review panel, through the HTTP
 * API a person's browser uses, and check how every run ends.
 *
 * Against a running API (the e2e stack: migrated, seeded with the test user,
 * models configured through the instance environment), it:
 *
 *   1. creates two matters, uploads two contracts into the first and a signed
 *      precedent into the second (fixtures in `lib/playbook-journey-fixtures`),
 *   2. saves a playbook with a position for each check kind, so its asks are
 *      derived by the model at save time,
 *   3. runs the playbook from the table over both contracts (columns), and
 *   4. reviews each contract from the panel: the long one against the
 *      playbook, the other against the playbook plus positions proposed from
 *      the precedent in the other matter.
 *
 * Checks (`lib/playbook-journey-checks`): every run reaches `completed`;
 * progress accounts for every finding and never stalls at 0; no verdict is
 * `missing`, unfinished or read from a cut document; each tier is one the
 * fixture expects; panel deviations carry a proposed fix; the table's verdict
 * cells hold known tiers that agree with the table run's findings.
 *
 * Usage (from apps/api, with the stack up):
 *   bun evals/playbook-journey.ts [--api-url http://localhost:3001]
 *     [--storage-state ../../.playwright/storage-state.json] [--json out.json]
 */
import { panic } from "better-result";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

import { createSafeId } from "@/api/lib/branded-types";
import type { Position } from "@/api/lib/workflow/playbook-positions";

import {
  checkBadges,
  checkFindings,
  checkRunProgress,
  pollOf,
  runDetailSchema,
} from "./lib/playbook-journey-checks";
import type {
  ExpectedTiers,
  RunDetail,
  RunPoll,
} from "./lib/playbook-journey-checks";
import {
  EXPECTED_REFERENCE_TIERS,
  EXPECTED_TIERS,
  FIX_EXPECTED_POSITION_IDS,
  fixtureDocx,
  JOURNEY_CONTRACT,
  JOURNEY_DOCUMENTS,
  JOURNEY_POSITIONS,
} from "./lib/playbook-journey-fixtures";
import type { JourneyContract } from "./lib/playbook-journey-fixtures";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const REQUEST_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 15 * 60_000;
const POLL_INTERVAL_MS = 5000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// --------------- Options ---------------

type Options = {
  apiUrl: string;
  storageStatePath: string;
  jsonPath: string | null;
};

const parseArgs = (argv: readonly string[]): Options => {
  const options: Options = {
    apiUrl: "http://localhost:3001",
    storageStatePath: path.resolve(
      import.meta.dir,
      "../../../.playwright/storage-state.json",
    ),
    jsonPath: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1] ?? panic(`${String(flag)} needs a value`);
    switch (flag) {
      case "--api-url":
        options.apiUrl = value;
        break;
      case "--storage-state":
        options.storageStatePath = path.resolve(value);
        break;
      case "--json":
        options.jsonPath = value;
        break;
      default:
        return panic(`Unknown flag ${String(flag)}`);
    }
  }
  return options;
};

// --------------- HTTP ---------------

const storageStateSchema = v.object({
  cookies: v.array(v.object({ name: v.string(), value: v.string() })),
});

const readSessionCookie = async (storageStatePath: string): Promise<string> => {
  const { cookies } = v.parse(
    storageStateSchema,
    await Bun.file(storageStatePath).json(),
  );
  if (cookies.length === 0) {
    return panic(`${storageStatePath} holds no session cookie`);
  }
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
};

type Api = {
  send: (
    method: string,
    route: string,
    body?: unknown,
  ) => Promise<{ status: number; json: unknown }>;
  upload: (
    workspaceId: string,
    propertyId: string,
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<unknown>;
};

const createApi = (apiUrl: string, cookie: string): Api => {
  const call = async (method: string, route: string, body?: BodyInit) => {
    const response = await fetch(`${apiUrl}/v1${route}`, {
      method,
      headers: {
        cookie,
        ...(typeof body === "string"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    const json: unknown = text.length === 0 ? null : JSON.parse(text);
    return { status: response.status, json };
  };
  const expectOk = async (
    method: string,
    route: string,
    body?: BodyInit,
  ): Promise<{ status: number; json: unknown }> => {
    const result = await call(method, route, body);
    if (result.status >= 400 && result.status !== 428) {
      return panic(
        `${method} ${route} -> ${String(result.status)}: ${JSON.stringify(result.json)}`,
      );
    }
    return result;
  };
  return {
    send: async (method, route, body) =>
      await expectOk(
        method,
        route,
        body === undefined ? undefined : JSON.stringify(body),
      ),
    upload: async (workspaceId, propertyId, fileName, bytes) => {
      const form = new FormData();
      form.append("file", new File([bytes], fileName, { type: DOCX_MIME }));
      form.append("name", fileName);
      form.append("propertyId", propertyId);
      return (await expectOk("POST", `/entities/${workspaceId}/upload`, form))
        .json;
    },
  };
};

// --------------- Steps ---------------

const propertySchema = v.object({
  id: v.string(),
  name: v.string(),
  content: v.object({ type: v.string() }),
  tool: v.object({
    type: v.string(),
    askPropertyId: v.optional(v.string()),
  }),
});

const entitySchema = v.object({
  fields: v.array(
    v.object({
      id: v.string(),
      propertyId: v.string(),
      content: v.looseObject({
        type: v.string(),
        value: v.optional(v.unknown()),
      }),
    }),
  ),
});

type Matter = { id: string; filePropertyId: string };
type Document = { workspaceId: string; entityId: string; fileFieldId: string };

const createMatter = async (api: Api, label: string): Promise<Matter> => {
  const id: string = createSafeId<"workspace">();
  await api.send("PUT", "/workspaces", {
    id,
    name: `Playbook journey ${label} ${id.slice(0, 8)}`,
    filePropertyName: "Documents",
  });
  const properties = v.parse(
    v.array(propertySchema),
    (await api.send("GET", `/properties/${id}`)).json,
  );
  const file =
    properties.find((property) => property.content.type === "file") ??
    panic(`Matter ${id} has no file property`);
  return { id, filePropertyId: file.id };
};

const uploadDocument = async (
  api: Api,
  matter: Matter,
  { fileName, text }: { fileName: string; text: string },
): Promise<Document> => {
  const { entityId } = v.parse(
    v.object({ entityId: v.string() }),
    await api.upload(
      matter.id,
      matter.filePropertyId,
      fileName,
      await fixtureDocx(text),
    ),
  );
  const entity = v.parse(
    entitySchema,
    (await api.send("GET", `/entities/${matter.id}/entity/${entityId}`)).json,
  );
  const field =
    entity.fields.find(
      (candidate) =>
        candidate.propertyId === matter.filePropertyId &&
        candidate.content.type === "file",
    ) ?? panic(`${fileName} has no file field`);
  return { workspaceId: matter.id, entityId, fileFieldId: field.id };
};

const playbookSchema = v.object({
  id: v.string(),
  positions: v.object({ items: v.array(v.looseObject({})) }),
});

/** Saves the playbook (deriving each auto ask) and reads back what the panel
 *  sends: the stored positions, derived asks included. */
const savePlaybook = async (
  api: Api,
): Promise<{ id: string; positions: Position[]; problems: string[] }> => {
  const { id } = v.parse(
    v.object({ id: v.string() }),
    (
      await api.send("POST", "/playbooks", {
        name: `Playbook journey ${new Date().toISOString()}`,
        positions: { version: 3, items: JOURNEY_POSITIONS },
      })
    ).json,
  );
  const stored = v.parse(
    playbookSchema,
    (await api.send("GET", `/playbooks/${id}`)).json,
  );
  // The API validated these on save; the journey sends them back unchanged.
  const positions = stored.positions.items as Position[];
  const problems = positions.flatMap((position) =>
    position.mode === "graded" &&
    position.ask.mode === "auto" &&
    position.ask.derived === undefined
      ? [`${position.issue}: no ask was derived at save time`]
      : [],
  );
  return { id, positions, problems };
};

const sleep = async (ms: number) => {
  await Bun.sleep(ms);
};

const readRun = async (
  api: Api,
  workspaceId: string,
  runId: string,
): Promise<RunDetail> =>
  v.parse(
    runDetailSchema,
    (
      await api.send(
        "GET",
        `/workspaces/${workspaceId}/document-reviews/runs/${runId}`,
      )
    ).json,
  );

/** Polls a run to a terminal status, keeping every poll for the progress
 *  check. A run still open at the deadline is returned as it stands. */
const watchRun = async (
  api: Api,
  workspaceId: string,
  runId: string,
): Promise<{ detail: RunDetail; polls: RunPoll[] }> => {
  const polls: RunPoll[] = [];
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const detail = await readRun(api, workspaceId, runId);
    polls.push(pollOf(detail));
    if (TERMINAL_STATUSES.has(detail.run.status) || Date.now() > deadline) {
      return { detail, polls };
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

const runListSchema = v.object({
  items: v.array(v.object({ id: v.string(), executor: v.string() })),
});

/** The table run the playbook run opened for one document. */
const findTableRun = async (api: Api, document: Document): Promise<string> => {
  const query = new URLSearchParams({
    entityId: document.entityId,
    fileFieldId: document.fileFieldId,
  });
  const { items } = v.parse(
    runListSchema,
    (
      await api.send(
        "GET",
        `/workspaces/${document.workspaceId}/document-reviews/runs?${query.toString()}`,
      )
    ).json,
  );
  return (
    items.find((item) => item.executor === "table")?.id ??
    panic(`No table run for ${document.entityId}`)
  );
};

/** The verdict cells the table badge renders for one document. */
const readVerdictCells = async (
  api: Api,
  document: Document,
): Promise<(string | null)[]> => {
  const properties = v.parse(
    v.array(propertySchema),
    (await api.send("GET", `/properties/${document.workspaceId}`)).json,
  );
  const verdictIds = new Set(
    properties
      .filter((property) => property.tool.type === "playbook-verdict")
      .map((property) => property.id),
  );
  const entity = v.parse(
    entitySchema,
    (
      await api.send(
        "GET",
        `/entities/${document.workspaceId}/entity/${document.entityId}`,
      )
    ).json,
  );
  return entity.fields
    .filter((field) => verdictIds.has(field.propertyId))
    .map((field) =>
      typeof field.content.value === "string" ? field.content.value : null,
    );
};

/** Starts a panel review the way the inspector does, restating the size
 *  estimate when the API asks for it. */
const startPanelRun = async (
  api: Api,
  body: Record<string, unknown>,
  workspaceId: string,
): Promise<string> => {
  const route = `/workspaces/${workspaceId}/document-reviews/runs`;
  let response = await api.send("POST", route, body);
  if (response.status === 428) {
    const { confirmation } = v.parse(
      v.object({ confirmation: v.object({ estimatedUnits: v.number() }) }),
      response.json,
    );
    response = await api.send("POST", route, {
      ...body,
      confirmedUnits: confirmation.estimatedUnits,
    });
  }
  return v.parse(v.object({ runId: v.string() }), response.json).runId;
};

const proposedSchema = v.object({
  positions: v.array(v.looseObject({ mode: v.string() })),
});

// --------------- Journey ---------------

type RunReport = {
  label: string;
  surface: "table" | "panel";
  contract: JourneyContract;
  runId: string | null;
  status: string | null;
  verdicts: { position: string; verdict: string | null }[];
  problems: string[];
};

const expectedFor = (contract: JourneyContract): ExpectedTiers => ({
  byPositionId: EXPECTED_TIERS[contract],
  reference: EXPECTED_REFERENCE_TIERS,
  fixPositionIds: FIX_EXPECTED_POSITION_IDS,
});

const summarize = (
  detail: RunDetail,
): Pick<RunReport, "runId" | "status" | "verdicts"> => ({
  runId: detail.run.id,
  status: detail.run.status,
  verdicts: detail.findings.map((finding) => ({
    position: finding.positionTitle,
    verdict: finding.payload.finding.verdict,
  })),
});

const runJourney = async (api: Api): Promise<RunReport[]> => {
  const reports: RunReport[] = [];
  const contracts = await createMatter(api, "contracts");
  const precedents = await createMatter(api, "precedents");
  const documents: Record<JourneyContract, Document> = {
    long: await uploadDocument(api, contracts, JOURNEY_DOCUMENTS.long),
    reference: await uploadDocument(
      api,
      contracts,
      JOURNEY_DOCUMENTS.reference,
    ),
  };
  const precedent = await uploadDocument(
    api,
    precedents,
    JOURNEY_DOCUMENTS.precedent,
  );

  const playbook = await savePlaybook(api);
  if (playbook.problems.length > 0) {
    reports.push({
      label: "playbook save",
      surface: "panel",
      contract: JOURNEY_CONTRACT.long,
      runId: null,
      status: null,
      verdicts: [],
      problems: playbook.problems,
    });
  }
  const enabled = playbook.positions.filter((position) => position.enabled);

  // From the table: one run per document, both opened by one request.
  const started = v.parse(
    v.object({ documentRunCount: v.number() }),
    (
      await api.send(
        "POST",
        `/workspaces/${contracts.id}/playbooks/${playbook.id}/run`,
        { projection: "columns" },
      )
    ).json,
  );
  if (started.documentRunCount !== 2) {
    return panic(
      `The table run opened ${String(started.documentRunCount)} runs for 2 documents`,
    );
  }
  for (const contract of Object.values(JOURNEY_CONTRACT)) {
    const document = documents[contract];
    const runId = await findTableRun(api, document);
    const { detail, polls } = await watchRun(api, contracts.id, runId);
    const problems = [
      ...checkRunProgress({
        detail,
        polls,
        expectedFindings: enabled.length,
      }),
      ...checkFindings({
        findings: detail.findings,
        expected: expectedFor(contract),
        expectFixes: false,
      }),
      ...checkBadges({
        cellValues: await readVerdictCells(api, document),
        findings: detail.findings,
      }),
    ];
    reports.push({
      label: `table · ${contract}`,
      surface: "table",
      contract,
      ...summarize(detail),
      problems,
    });
  }

  // From the panel: the long contract against the playbook as saved.
  const perspective = { type: "neutral" };
  {
    const document = documents.long;
    const runId = await startPanelRun(
      api,
      {
        target: {
          entityId: document.entityId,
          fileFieldId: document.fileFieldId,
        },
        playbookId: playbook.id,
        positions: enabled,
        references: [],
        perspective,
        skipped: [],
      },
      contracts.id,
    );
    const { detail, polls } = await watchRun(api, contracts.id, runId);
    reports.push({
      label: "panel · long",
      surface: "panel",
      contract: JOURNEY_CONTRACT.long,
      ...summarize(detail),
      problems: [
        ...checkRunProgress({
          detail,
          polls,
          expectedFindings: enabled.length,
        }),
        ...checkFindings({
          findings: detail.findings,
          expected: expectedFor(JOURNEY_CONTRACT.long),
          expectFixes: true,
        }),
      ],
    });
  }

  // From the panel, with a precedent from the other matter as reference: the
  // proposal pins the precedent's passages, then the run grades the playbook's
  // positions and the proposed ones together.
  {
    const document = documents.reference;
    const target = {
      entityId: document.entityId,
      fileFieldId: document.fileFieldId,
    };
    const references = [
      {
        workspaceId: precedent.workspaceId,
        entityId: precedent.entityId,
        fileFieldId: precedent.fileFieldId,
      },
    ];
    const proposed = v.parse(
      proposedSchema,
      (
        await api.send(
          "POST",
          `/workspaces/${contracts.id}/document-reviews/positions`,
          { target, references, seededPositions: enabled, perspective },
        )
      ).json,
    );
    // The API validated these when it pinned them.
    const positions = proposed.positions as Position[];
    const referencePositions = positions.filter(
      (position) =>
        position.mode === "graded" && position.standard.source === "reference",
    );
    const runId = await startPanelRun(
      api,
      {
        target,
        playbookId: playbook.id,
        positions,
        references,
        perspective,
        skipped: [],
      },
      contracts.id,
    );
    const { detail, polls } = await watchRun(api, contracts.id, runId);
    reports.push({
      label: "panel · reference",
      surface: "panel",
      contract: JOURNEY_CONTRACT.reference,
      ...summarize(detail),
      problems: [
        ...(referencePositions.length === 0
          ? ["the precedent yielded no reference position"]
          : []),
        ...checkRunProgress({
          detail,
          polls,
          expectedFindings: positions.length,
        }),
        ...checkFindings({
          findings: detail.findings,
          expected: expectedFor(JOURNEY_CONTRACT.reference),
          expectFixes: true,
        }),
      ],
    });
  }
  return reports;
};

const renderReport = (reports: readonly RunReport[]): string =>
  [
    "## Playbook journey",
    "",
    "| Run | Status | Verdicts | Problems |",
    "| --- | --- | --- | --- |",
    ...reports.map(
      (report) =>
        `| ${report.label} | ${report.status ?? "-"} | ${
          report.verdicts
            .map(({ position, verdict }) => `${position}: ${String(verdict)}`)
            .join("<br>") || "-"
        } | ${report.problems.join("<br>") || "none"} |`,
    ),
    "",
    `${String(reports.filter((report) => report.problems.length === 0).length)}/${String(reports.length)} runs passed`,
  ].join("\n");

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const api = createApi(
    options.apiUrl,
    await readSessionCookie(options.storageStatePath),
  );
  const reports = await runJourney(api);
  process.stdout.write(`${renderReport(reports)}\n`);
  if (options.jsonPath !== null) {
    await writeFile(options.jsonPath, JSON.stringify(reports, null, 2));
  }
  if (reports.some((report) => report.problems.length > 0)) {
    process.exitCode = 1;
  }
};

await main();
