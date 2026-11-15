import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as v from "valibot";

import { CASE_LAW_COVERAGE_CURRENT_WITHIN_MS } from "../apps/api/src/lib/case-law/coverage-freshness";
import type {
  READ_CASE_LAW_DECISION_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
  SEARCH_LEGISLATION_PROJECTION,
} from "../apps/api/src/lib/chat/projections";
import defaultBusyWindows from "../packages/db-load-gate/src/default-busy-windows.json" with { type: "json" };
import { DAY_SECONDS } from "./check-npm-publish-lag";

type FoundDecision = Extract<
  v.InferInput<typeof READ_CASE_LAW_DECISION_PROJECTION>["items"][number],
  { status: "found" }
>;
type CaseHit = Extract<
  v.InferInput<typeof SEARCH_CASE_LAW_PROJECTION>,
  { results: unknown[] }
>["results"][number];
type StatuteHit = Extract<
  v.InferInput<typeof SEARCH_LEGISLATION_PROJECTION>,
  { results: unknown[] }
>["results"][number];
// A read without text names why instead (a licence or an unserved document).
const readFixture = (text: string | undefined) =>
  ({
    items: [
      {
        status: "found",
        decision:
          text === undefined ? { textWithheldReason: "fixture" } : { text },
      },
    ],
  }) satisfies {
    items: {
      status: FoundDecision["status"];
      decision: Pick<FoundDecision["decision"], "text" | "textWithheldReason">;
    }[];
  };
const caseHit = { decisionId: "fixture", caseNumber: "fixture" } satisfies Pick<
  CaseHit,
  "decisionId" | "caseNumber"
>;
const statuteHit = {
  documentId: "fixture",
  eli: "fixture",
  title: "fixture",
} satisfies Pick<StatuteHit, "documentId" | "eli" | "title">;

const ROOT = new URL("../", import.meta.url).pathname;

const HOUR_SECONDS = 3600;
const MINUTE_SECONDS = 60;
const busyHoldMarginSeconds = CASE_LAW_COVERAGE_CURRENT_WITHIN_MS / 1000;
// The first default busy window on a winter weekday, as epoch seconds.
const [busyWindow] = defaultBusyWindows;
if (!busyWindow) {
  throw new Error("expected a default busy window");
}
const zonedEpoch = (date: string, time: string, timeZone: string) => {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute);
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(wall)
      .find(({ type }) => type === "timeZoneName")?.value ?? "GMT";
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/u.exec(offset);
  const offsetMinutes = match?.[1]
    ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
    : 0;
  return (wall - offsetMinutes * 60_000) / 1000;
};
const busyWindowStart = zonedEpoch(
  "2026-11-04",
  busyWindow.start,
  busyWindow.timeZone,
);
const busyWindowEnd = zonedEpoch(
  "2026-11-04",
  busyWindow.end,
  busyWindow.timeZone,
);
const SENTINEL = "private-body-sentinel";
const WEB_HTML =
  '<h1>Fixture</h1><a href="/law/cze/cases/fixture">case</a><a href="/law/cze/statutes/fixture">statute</a><article>text</article>';

type Scenario = {
  status?: number;
  html?: string;
  delay?: number;
  firstStatus?: number;
  firstHtml?: string;
  rpc?:
    | "error"
    | "malformed"
    | "wrong-id"
    | "tool-error"
    | "empty"
    | "wrong-shape"
    | "empty-text"
    | "whitespace-text"
    | "withheld-text"
    | "sse"
    | "auth-error"
    | "invalid-hit"
    | "absent-decision"
    | "stale-coverage";
  promotionVersion?: string;
  promotionAgeSeconds?: number;
  cliVersion?: string;
  cliExit?: string;
  cliDiagnostic?: string;
  installExit?: string;
  tags?: string[];
  latest?: string;
  newestReleaseStatus?: number;
  newestReleaseDraft?: boolean;
  newestTagType?: "tag" | "commit";
  newestTagCreatedAt?: string;
  releaseWorkflowStatus?: "queued" | "in_progress" | "completed";
  releaseWorkflowConclusion?: "success" | "failure";
  releaseWorkflowRuns?: readonly WorkflowRun[];
  desktopWorkflowStatus?: "queued" | "in_progress" | "completed";
  desktopWorkflowConclusion?: "success" | "failure";
  desktopWorkflowRuns?: readonly WorkflowRun[];
  assetStatus?: number;
  firstAssetStatus?: number;
  session?: "required" | "notification-error";
  redirect?: "once" | "chain";
  searchSlot?: string;
  probeSlot?: string;
  probeError?: string;
  probeRunning?: "once" | "always";
  probeRunSeconds?: string;
  coverage?: { status: string; ageSeconds: number };
  nowEpoch?: number;
  /** The clock once the coverage call has been answered; `nowEpoch` is the
   *  clock before it. */
  nowEpochAfterCoverage?: number;
  busyWindowsFile?: string;
};

type WorkflowRun = {
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | null;
  created_at: string;
  display_title?: string;
};

const coverageFixture = (status: string, ageSeconds = 60) => ({
  asOf: "2026-11-01T10:00:00.000Z",
  freshness: { status, ageSeconds },
  countries: [
    {
      country: "CZE",
      availability: "searchable",
      sources: [{ adapterKey: "fixture" }],
    },
    { country: "USA", availability: "in-preparation", sources: [] },
  ],
});

type McpPayloadOptions = {
  name: string;
  rpc: Scenario["rpc"];
  coverage: Scenario["coverage"];
};
const mcpPayload = ({ name, rpc, coverage }: McpPayloadOptions) => {
  if (name === "case_law_coverage") {
    if (rpc === "empty") {
      return { ...coverageFixture("current"), countries: [] };
    }
    if (coverage) {
      return coverageFixture(coverage.status, coverage.ageSeconds);
    }
    return coverageFixture(
      rpc === "stale-coverage" ? "refresh_pending" : "current",
    );
  }
  if (name !== "read_case_law_decision") {
    if (rpc === "empty") {
      return { results: [] };
    }
    if (rpc === "invalid-hit") {
      return { results: [null] };
    }
    return { results: [name === "search_case_law" ? caseHit : statuteHit] };
  }
  if (rpc === "absent-decision") {
    return { items: [{ status: "found", text: SENTINEL }] };
  }
  if (rpc === "empty-text") {
    return readFixture("");
  }
  if (rpc === "whitespace-text") {
    return readFixture(" \n ");
  }
  if (rpc === "withheld-text") {
    return readFixture(undefined);
  }
  return readFixture(SENTINEL);
};

type ToolResultOptions = {
  scenario: Scenario;
  args: unknown;
  payload: unknown;
};
const toolResult = ({ scenario, args, payload }: ToolResultOptions) => {
  if (scenario.probeError !== undefined) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: scenario.probeError } }),
        },
      ],
    };
  }
  const continued =
    typeof args === "object" && args !== null && "continuation_token" in args;
  const running =
    scenario.probeRunning === "always" ||
    (scenario.probeRunning === "once" && !continued);
  const wrongShape = scenario.rpc === "wrong-shape";
  let text = JSON.stringify(payload);
  if (wrongShape) {
    text = JSON.stringify({ unrelated: SENTINEL });
  }
  if (running) {
    text = JSON.stringify({
      status: "running",
      continuationToken: "fixture-continuation",
      retryAfterMs: 1,
    });
  }
  return {
    isError: scenario.rpc === "tool-error",
    content: [{ type: "text", text }],
  };
};

type RedirectFixtureOptions = { pathname: string; mode: Scenario["redirect"] };
const redirectFixture = ({ pathname, mode }: RedirectFixtureOptions) => {
  if (mode === undefined) {
    return null;
  }
  if (pathname === "/law/cze/statutes/") {
    return new Response(SENTINEL, {
      status: 301,
      headers: { location: "/statutes-final" },
    });
  }
  if (mode === "chain" && pathname === "/statutes-final") {
    return new Response(SENTINEL, {
      status: 301,
      headers: { location: "/statutes-other" },
    });
  }
  return null;
};

type DesktopFixtureOptions = { pathname: string; scenario: Scenario };
const desktopFixture = ({ pathname, scenario }: DesktopFixtureOptions) => {
  if (pathname === "/desktop/latest") {
    return Response.json({
      tag_name: scenario.latest ?? "v10.0.0",
      draft: false,
      prerelease: false,
      assets: [
        "Stella-macos-universal.dmg",
        "Stella-windows-x64-setup.exe",
        "latest.json",
      ].map((name) => ({ name })),
    });
  }
  if (pathname === "/desktop/tags") {
    return Response.json(
      (scenario.tags ?? ["v2.0.0", "v10.0.0", "v11.0.0-beta.1"]).map((tag) => ({
        ref: `refs/tags/${tag}`,
        object: { type: scenario.newestTagType ?? "tag", sha: `sha-${tag}` },
      })),
    );
  }
  if (pathname === "/desktop/tag-object") {
    return Response.json({
      tagger: {
        date: scenario.newestTagCreatedAt ?? "2026-10-09T09:00:00Z",
      },
    });
  }
  if (pathname === "/desktop/release") {
    if (scenario.newestReleaseStatus !== undefined) {
      return new Response(null, { status: scenario.newestReleaseStatus });
    }
    return Response.json({
      tag_name: "v10.0.0",
      draft: scenario.newestReleaseDraft ?? false,
    });
  }
  if (pathname === "/desktop/release-workflow") {
    return Response.json({
      workflow_runs: (
        scenario.releaseWorkflowRuns ?? [
          {
            status: scenario.releaseWorkflowStatus ?? "completed",
            conclusion: scenario.releaseWorkflowConclusion ?? "success",
            created_at: "2026-10-09T09:00:00Z",
          },
        ]
      ).map((run) => ({
        ...run,
        display_title: run.display_title ?? "Release Artifacts v10.0.0",
      })),
    });
  }
  // GitHub lists a dispatched release run and every workflow_run-triggered
  // run under the default branch, so a branch-filtered query for the tag
  // finds none of them.
  if (
    pathname === "/desktop/release-workflow-by-branch" ||
    pathname === "/desktop/desktop-workflow-by-branch"
  ) {
    return Response.json({ workflow_runs: [] });
  }
  if (pathname === "/desktop/desktop-workflow") {
    return Response.json({
      workflow_runs: (
        scenario.desktopWorkflowRuns ?? [
          {
            status: scenario.desktopWorkflowStatus ?? "completed",
            conclusion: scenario.desktopWorkflowConclusion ?? "success",
            created_at: "2026-10-09T09:00:00Z",
          },
        ]
      ).map((run) => ({
        ...run,
        display_title: run.display_title ?? "Desktop Release Artifacts v10.0.0",
      })),
    });
  }
  return null;
};

const assetStatusFor = (scenario: Scenario, attempt: number | undefined) =>
  attempt === 1 && scenario.firstAssetStatus
    ? scenario.firstAssetStatus
    : (scenario.assetStatus ?? 200);

type RunOptions = {
  scenario?: Scenario;
  mode?: "web" | "cli" | "desktop" | "search-probe";
  token?: string;
};
const run = async ({
  scenario = {},
  mode = "web",
  token = "fixture-token",
}: RunOptions = {}) => {
  const work = await mkdtemp(path.join(tmpdir(), "journey-test-"));
  const counts = new Map<string, number>();
  const calls: { name: string; args: unknown }[] = [];
  const searchUrls: string[] = [];
  let initialized = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
      if (pathname === "/law/cases") {
        searchUrls.push(`${pathname}${url.search}`);
      }
      if (pathname === "/releases") {
        return Response.json([
          {
            tag_name: "v1.0.0",
            draft: false,
            prerelease: false,
            published_at: new Date(
              Date.now() - (scenario.promotionAgeSeconds ?? 3600) * 1000,
            ).toISOString(),
          },
        ]);
      }
      const desktop = desktopFixture({ pathname, scenario });
      if (desktop !== null) {
        return desktop;
      }
      const redirect = redirectFixture({ pathname, mode: scenario.redirect });
      if (redirect !== null) {
        return redirect;
      }
      if (req.method === "HEAD") {
        return new Response(null, {
          status: assetStatusFor(scenario, counts.get(pathname)),
        });
      }
      if (pathname.startsWith("/cli/")) {
        expect(req.headers.get("Authorization")).toBe(`Bearer ${token}`);
        if (scenario.rpc === "wrong-shape") {
          return Response.json({ unrelated: SENTINEL });
        }
        return Response.json(
          pathname.endsWith("read")
            ? readFixture(SENTINEL)
            : { results: [caseHit] },
        );
      }
      if (scenario.delay) {
        await Bun.sleep(scenario.delay);
      }
      const status =
        pathname !== "/mcp" &&
        counts.get(pathname) === 1 &&
        scenario.firstStatus
          ? scenario.firstStatus
          : (scenario.status ?? 200);
      if (status !== 200) {
        return new Response(SENTINEL, { status });
      }
      if (pathname !== "/mcp") {
        return new Response(
          `${(counts.get(pathname) === 1 ? scenario.firstHtml : undefined) ?? scenario.html ?? WEB_HTML}${SENTINEL}`,
        );
      }
      expect(req.headers.get("Authorization")).toBe(`Bearer ${token}`);
      const body: unknown = await req.json();
      if (typeof body !== "object" || body === null || !("method" in body)) {
        return new Response(null, { status: 400 });
      }
      if (body.method !== "initialize" && scenario.session) {
        if (
          req.headers.get("Mcp-Session-Id") !== "fixture-session" ||
          req.headers.get("MCP-Protocol-Version") !== "2025-06-18"
        ) {
          return new Response(SENTINEL, { status: 400 });
        }
        if (body.method === "notifications/initialized") {
          if (scenario.session === "notification-error") {
            return new Response(SENTINEL, { status: 503 });
          }
          initialized = true;
          return new Response(null, { status: 202 });
        }
        if (!initialized) {
          return new Response(SENTINEL, { status: 400 });
        }
      }
      if (!("id" in body)) {
        return new Response(null, { status: 400 });
      }
      if (scenario.rpc === "malformed") {
        return new Response(SENTINEL);
      }
      if (scenario.rpc === "error" || scenario.rpc === "auth-error") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32_000,
            message:
              scenario.rpc === "auth-error"
                ? `key rejected ${SENTINEL}`
                : SENTINEL,
          },
        });
      }
      let result: unknown;
      if (body.method === "initialize") {
        result = {
          protocolVersion: scenario.session ? "2025-06-18" : "2025-11-25",
          serverInfo: { name: SENTINEL },
        };
      } else {
        if (
          !("params" in body) ||
          typeof body.params !== "object" ||
          body.params === null ||
          !("name" in body.params) ||
          !("arguments" in body.params) ||
          typeof body.params.name !== "string"
        ) {
          return new Response(null, { status: 400 });
        }
        calls.push({ name: body.params.name, args: body.params.arguments });
        if (
          body.params.name === "case_law_coverage" &&
          scenario.nowEpochAfterCoverage !== undefined
        ) {
          await Bun.write(path.join(work, "coverage-served"), "");
        }
        result = toolResult({
          scenario,
          args: body.params.arguments,
          payload: mcpPayload({
            name: body.params.name,
            rpc: scenario.rpc,
            coverage: scenario.coverage,
          }),
        });
      }
      const envelope = {
        jsonrpc: "2.0",
        id: scenario.rpc === "wrong-id" ? 99 : body.id,
        result,
      };
      return scenario.rpc === "sse"
        ? new Response(
            `event: message\ndata: ${JSON.stringify(envelope)}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : Response.json(envelope, {
            headers:
              scenario.session && body.method === "initialize"
                ? { "Mcp-Session-Id": "fixture-session" }
                : {},
          });
    },
  });
  try {
    await Bun.write(path.join(work, "cli-calls"), "");
    await Bun.write(
      path.join(work, "npm"),
      `#!/usr/bin/env bash\nif [[ -n "\${MCP_CANARY_TOKEN:-}" || -n "\${STELLA_API_KEY:-}" || " $* " != *" --ignore-scripts "* ]]; then exit 1; fi\necho clean > "$INSTALL_CHECK"\necho 'npm fixture failure' >&2\nif [[ "$INSTALL_EXIT" != 0 ]]; then exit "$INSTALL_EXIT"; fi\nwhile [[ "$1" != --prefix ]]; do shift; done\nmkdir -p "$2/bin"\ncp "$CLI_FIXTURE" "$2/bin/stella"\n`,
    );
    await Bun.write(
      path.join(work, "stella"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CLI_CALL_LOG"\nprintf '%s\\n' "$CLI_DIAGNOSTIC" >&2\necho '${SENTINEL}' >&2\nif [[ "$1" == --version ]]; then if [[ -n "\${MCP_CANARY_TOKEN:-}" || -n "\${STELLA_API_KEY:-}" ]]; then exit 1; fi; printf '%s\\n' "$CLI_VERSION"; exit 0; fi\nif [[ "$CLI_EXIT" != 0 ]]; then exit "$CLI_EXIT"; fi\ncurl -sS -H "Authorization: Bearer $STELLA_API_KEY" "$STELLA_SERVER_URL/cli/$2"\n`,
    );
    await Bun.write(
      path.join(work, "git"),
      `#!/usr/bin/env bash\nif [[ "$*" == "show v1.0.0:packages/cli/package.json" ]]; then printf '{"name":"@stll/cli","version":"%s"}\\n' "$PROMOTION_VERSION"; else exit 1; fi\n`,
    );
    await Bun.write(
      path.join(work, "gh"),
      `#!/usr/bin/env bash
case "$*" in
  *git/tags/*) route=tag-object ;;
  *matching-refs*) route=tags ;;
  *releases/tags*) route=release ;;
  *release-desktop.yml*branch=*) route=desktop-workflow-by-branch ;;
  *release-desktop.yml*) route=desktop-workflow ;;
  *release.yml*branch=*) route=release-workflow-by-branch ;;
  *release.yml*) route=release-workflow ;;
  *) route=latest ;;
esac
response=$(mktemp)
status=$(curl --silent --show-error --output "$response" --write-out '%{http_code}' "$FAKE_SERVER/desktop/$route") || exit $?
if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
  rm -f "$response"
  echo "gh: fixture request failed (HTTP $status)" >&2
  exit 1
fi
cat "$response"
rm -f "$response"
`,
    );
    // A clock that moves once the coverage call has been answered.
    if (scenario.nowEpochAfterCoverage !== undefined) {
      await Bun.write(
        path.join(work, "date"),
        `#!/usr/bin/env bash\nif [[ "$*" == "+%s" ]]; then if [[ -e "$JOURNEY_TEST_COVERAGE_SERVED" ]]; then printf '%s\\n' "$JOURNEY_TEST_CLOCK_AFTER"; else printf '%s\\n' "$JOURNEY_TEST_CLOCK_BEFORE"; fi; exit 0; fi\nexec /bin/date "$@"\n`,
      );
      await chmod(path.join(work, "date"), 0o755);
    }
    await Promise.all(
      ["npm", "stella", "gh", "git"].map(async (file) => {
        await chmod(path.join(work, file), 0o755);
      }),
    );
    const child = Bun.spawn(
      [
        "bash",
        mode === "desktop"
          ? "scripts/check-desktop-release-policy.sh"
          : "scripts/check-journeys.sh",
        ...(mode === "cli" ? ["--cli"] : []),
        ...(mode === "search-probe" ? ["--search-probe"] : []),
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${work}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
          MCP_CANARY_TOKEN: token,
          JOURNEY_WEB_URL: server.url.toString().replace(/\/$/u, ""),
          JOURNEY_MCP_URL: `${server.url.toString()}mcp`,
          JOURNEY_CLI_URL: server.url.toString().replace(/\/$/u, ""),
          JOURNEY_RETRY_PAUSE_SECONDS: "0",
          JOURNEY_SEARCH_SLOT: scenario.searchSlot ?? "0",
          JOURNEY_PROBE_SLOT: scenario.probeSlot ?? "0",
          JOURNEY_PROBE_TIMEOUT_SECONDS: scenario.delay ? "0.1" : "3",
          JOURNEY_PROBE_RUN_SECONDS: scenario.probeRunSeconds ?? "240",
          // Outside the busy window unless a test moves the clock into it.
          ...(scenario.nowEpochAfterCoverage === undefined
            ? {
                JOURNEY_NOW_EPOCH: String(
                  scenario.nowEpoch ?? busyWindowStart - 3 * HOUR_SECONDS,
                ),
              }
            : {
                // Unpinned, so the canary reads the moving clock above.
                JOURNEY_NOW_EPOCH: "",
                JOURNEY_TEST_CLOCK_BEFORE: String(scenario.nowEpoch),
                JOURNEY_TEST_CLOCK_AFTER: String(
                  scenario.nowEpochAfterCoverage,
                ),
                JOURNEY_TEST_COVERAGE_SERVED: path.join(
                  work,
                  "coverage-served",
                ),
              }),
          ...(scenario.busyWindowsFile
            ? { JOURNEY_BUSY_WINDOWS_FILE: scenario.busyWindowsFile }
            : {}),
          STELLA_DESKTOP_RETRY_PAUSE_SECONDS: "0",
          STELLA_DESKTOP_NOW_EPOCH: "1791536400",
          JOURNEY_TIMEOUT_SECONDS: scenario.delay ? "0.1" : "3",
          CLI_FIXTURE: path.join(work, "stella"),
          JOURNEY_RELEASES_API_URL: `${server.url.toString()}releases`,
          PROMOTION_VERSION: scenario.promotionVersion ?? "10.0.0",
          CLI_VERSION: scenario.cliVersion ?? "10.0.0",
          CLI_EXIT: scenario.cliExit ?? "0",
          CLI_DIAGNOSTIC: scenario.cliDiagnostic ?? "",
          CLI_CALL_LOG: path.join(work, "cli-calls"),
          INSTALL_EXIT: scenario.installExit ?? "0",
          INSTALL_CHECK: path.join(work, "install-check"),
          GH_REPO: "fixture/repository",
          FAKE_SERVER: server.url.toString().replace(/\/$/u, ""),
          STELLA_DESKTOP_DOWNLOAD_BASE_URL: `${server.url.toString()}assets`,
          STELLA_DESKTOP_RELEASE_API_PATH: "",
          STELLA_DESKTOP_RELEASE_EXPECTED_TAG: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout + stderr).not.toContain(SENTINEL);
    expect(stdout + stderr).not.toContain(token || "absent-token");
    if (mode !== "desktop") {
      expect(stderr).toBe("");
      const lines = stdout.trim().split("\n");
      const failures = lines.filter((line) =>
        /^journey (cli_|mcp_)\S+ failed /u.test(line),
      );
      for (const failure of failures) {
        const name = failure.split(" ").at(1);
        expect(name).toBeDefined();
        expect(
          lines.filter((line) =>
            line.startsWith(`journey-detail ${name ?? ""} `),
          ),
        ).toHaveLength(1);
      }
      for (const line of lines.filter(
        (entry) =>
          !entry.startsWith("journey-detail ") &&
          !entry.startsWith("journey-timing "),
      )) {
        expect(line).toMatch(
          /^journey [a-z_]+ (passed|passed_after_retry|failed|skipped) (http_status|timeout|missing_marker|empty_result|stale_result|contract_error|publish_lagging|pending_release|promotion_unavailable|registry_rejected|no_credential|auth_rejected|network_error|run_budget|ok)$/u,
        );
      }
    }
    const cliCalls = (await Bun.file(path.join(work, "cli-calls")).text())
      .trim()
      .split("\n");
    const installClean = await Bun.file(
      path.join(work, "install-check"),
    ).exists();
    return {
      stdout,
      stderr,
      exit,
      counts,
      calls,
      searchUrls,
      cliCalls,
      installClean,
    };
  } finally {
    await server.stop(true);
    await rm(work, { recursive: true, force: true });
  }
};

describe("scheduled read journeys", () => {
  test("reports each public and authenticated probe", async () => {
    const result = await run();
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ passed /gu)).toHaveLength(8);
    expect(result.calls.map(({ name }) => name)).toEqual([
      "search_case_law",
      "read_case_law_decision",
      "search_legislation",
      "case_law_coverage",
    ]);
    expect(result.calls.at(0)?.args).toEqual({
      queries: ["smlouva"],
      country: "CZE",
      limit: 1,
    });
    expect(result.calls.at(2)?.args).toEqual({
      query: "smlouva",
      country: "CZE",
      limit: 1,
    });
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBe(8);
  });
  test("names all skips without credentials", async () => {
    const result = await run({ token: "" });
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ skipped no_credential/gu)).toHaveLength(5);
    expect(result.counts.get("/mcp")).toBeUndefined();
  });
  test("retries a request once and bounds the request budget", async () => {
    const result = await run({ scenario: { firstStatus: 503 } });
    expect(result.exit).toBe(0);
    expect(result.counts.get("/law/cases")).toBe(2);
    expect(
      result.stdout.match(/passed_after_retry http_status/gu),
    ).toHaveLength(3);
    expect(result.stdout).not.toContain("web_search passed ok");
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBe(11);
  });
  test("keeps every retry within the budget of a session run", async () => {
    const result = await run({
      scenario: { firstStatus: 503, session: "required" },
    });
    expect(result.exit).toBe(0);
    expect(
      result.stdout.match(/passed_after_retry http_status/gu),
    ).toHaveLength(3);
    expect(result.stdout).toContain("mcp_coverage passed ok");
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBe(12);
  });
  test("counts a bounded public redirect", async () => {
    const result = await run({ scenario: { redirect: "once" } });
    expect(result.exit).toBe(0);
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBe(9);
    const chain = await run({ scenario: { redirect: "chain" } });
    expect(chain.exit).toBe(1);
    expect(chain.stdout).toContain("web_statutes failed http_status");
    expect(
      [...chain.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(12);
  });
  test("retains the first failure reason after recovery", async () => {
    const result = await run({ scenario: { firstHtml: "<h1>Fixture</h1>" } });
    expect(result.exit).toBe(0);
    expect(
      result.stdout.match(/passed_after_retry missing_marker/gu),
    ).toHaveLength(3);
  });
  for (const [name, scenario, reason] of [
    ["HTTP status", { status: 503 }, "http_status"],
    ["HTTP unauthorized", { status: 401 }, "auth_rejected"],
    ["HTTP forbidden", { status: 403 }, "auth_rejected"],
    ["RPC credential rejection", { rpc: "auth-error" }, "auth_rejected"],
    ["invalid search hit", { rpc: "invalid-hit" }, "contract_error"],
    ["decision text envelope", { rpc: "absent-decision" }, "contract_error"],
    ["redirect status", { status: 302 }, "http_status"],
    [
      "script-only article",
      { html: "<h1>Fixture</h1><script><article>Fixture</article></script>" },
      "missing_marker",
    ],
    ["deadline", { delay: 250 }, "timeout"],
    [
      "rendered marker",
      {
        html: '<h1>Fixture</h1><script>href="/law/cze/cases/fixture"</script>',
      },
      "missing_marker",
    ],
    ["empty collection", { rpc: "empty" }, "empty_result"],
    ["empty text", { rpc: "empty-text" }, "empty_result"],
    ["whitespace text", { rpc: "whitespace-text" }, "empty_result"],
    ["withheld text", { rpc: "withheld-text" }, "empty_result"],
    ["RPC error", { rpc: "error" }, "contract_error"],
    ["malformed JSON", { rpc: "malformed" }, "contract_error"],
    ["RPC identity", { rpc: "wrong-id" }, "contract_error"],
    ["tool error", { rpc: "tool-error" }, "contract_error"],
    ["payload shape", { rpc: "wrong-shape" }, "contract_error"],
  ] as const) {
    test(`classifies ${name}`, async () => {
      const result = await run({ scenario });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain(`failed ${reason}`);
      expect(
        [...result.counts.values()].reduce((sum, value) => sum + value, 0),
      ).toBeLessThanOrEqual(12);
    });
  }
  test("negotiates a session and initializes it before tools", async () => {
    const result = await run({ scenario: { session: "required" } });
    expect(result.exit).toBe(0);
    expect(result.stdout).not.toContain("fixture-session");
    expect(result.counts.get("/mcp")).toBe(6);
  });
  test("reports initialization notification failures", async () => {
    const result = await run({ scenario: { session: "notification-error" } });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("mcp_initialize failed http_status");
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(12);
  });
  test("fails coverage whose refreshes stopped landing", async () => {
    const result = await run({ scenario: { rpc: "stale-coverage" } });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("journey mcp_coverage failed stale_result");
    expect(result.stdout).toContain("journey mcp_search passed ok");
  });
  describe("coverage held by the database busy window", () => {
    const passes = (stdout: string) =>
      expect(stdout).toContain("journey mcp_coverage passed ok");
    const fails = (stdout: string) =>
      expect(stdout).toContain("journey mcp_coverage failed stale_result");
    test("accepts a pending refresh while the window is open", async () => {
      expect(busyWindowEnd).toBeGreaterThan(busyWindowStart);
      const elapsed = 45 * MINUTE_SECONDS;
      const result = await run({
        scenario: {
          nowEpoch: busyWindowStart + elapsed,
          // The last refresh landed a minute before the window opened.
          coverage: {
            status: "refresh_pending",
            ageSeconds: elapsed + MINUTE_SECONDS,
          },
        },
      });
      expect(result.exit).toBe(0);
      passes(result.stdout);
    });
    test("accepts figures exactly at the margin before the window", async () => {
      const elapsed = 10 * MINUTE_SECONDS;
      const result = await run({
        scenario: {
          nowEpoch: busyWindowStart + elapsed,
          coverage: {
            status: "refresh_pending",
            ageSeconds: elapsed + busyHoldMarginSeconds,
          },
        },
      });
      expect(result.exit).toBe(0);
      passes(result.stdout);
    });
    test("fails a pending refresh outside the window", async () => {
      const result = await run({
        scenario: {
          nowEpoch: busyWindowEnd + 30 * MINUTE_SECONDS,
          coverage: {
            status: "refresh_pending",
            ageSeconds: 20 * MINUTE_SECONDS,
          },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
    test("fails a pending refresh once the window has closed", async () => {
      const result = await run({
        scenario: {
          nowEpoch: busyWindowEnd,
          coverage: {
            status: "refresh_pending",
            ageSeconds: busyWindowEnd - busyWindowStart,
          },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
    test("fails figures in another state than pending inside the window", async () => {
      const result = await run({
        scenario: {
          nowEpoch: busyWindowStart + 45 * MINUTE_SECONDS,
          coverage: { status: "stale", ageSeconds: 60 },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
    test("fails a refresh pending longer than the window plus the margin", async () => {
      const result = await run({
        scenario: {
          nowEpoch: busyWindowEnd - MINUTE_SECONDS,
          coverage: {
            status: "refresh_pending",
            ageSeconds:
              busyWindowEnd - busyWindowStart + busyHoldMarginSeconds + 1,
          },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
    test("fails figures that were already stale when the window opened", async () => {
      const elapsed = 10 * MINUTE_SECONDS;
      const result = await run({
        scenario: {
          nowEpoch: busyWindowStart + elapsed,
          coverage: {
            status: "refresh_pending",
            ageSeconds: elapsed + busyHoldMarginSeconds + 1,
          },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
    test("grants no hold without the busy windows file", async () => {
      const elapsed = 45 * MINUTE_SECONDS;
      const result = await run({
        scenario: {
          nowEpoch: busyWindowStart + elapsed,
          busyWindowsFile: path.join(ROOT, "missing-busy-windows.json"),
          coverage: {
            status: "refresh_pending",
            ageSeconds: elapsed + MINUTE_SECONDS,
          },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
    test("grants no hold for a time zone the tz database lacks", async () => {
      // Read as UTC, this window would be open at any hour of the run.
      const dir = await mkdtemp(path.join(tmpdir(), "journey-windows-"));
      const busyWindowsFile = path.join(dir, "busy-windows.json");
      await Bun.write(
        busyWindowsFile,
        JSON.stringify([
          { start: "00:00", end: "23:59", timeZone: "Invalid/Zone" },
        ]),
      );
      const elapsed = 45 * MINUTE_SECONDS;
      try {
        const result = await run({
          scenario: {
            nowEpoch: busyWindowStart + elapsed,
            busyWindowsFile,
            coverage: {
              status: "refresh_pending",
              ageSeconds: elapsed + MINUTE_SECONDS,
            },
          },
        });
        expect(result.exit).toBe(1);
        fails(result.stdout);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
    test("reads the window when the response arrives, not before the request", async () => {
      // Before the call the hold is 25 minutes; when the answer arrives 30
      // minutes later it is 55, so the 30-minute-old figures pass.
      const result = await run({
        scenario: {
          nowEpoch: busyWindowStart + 10 * MINUTE_SECONDS,
          nowEpochAfterCoverage: busyWindowStart + 40 * MINUTE_SECONDS,
          coverage: {
            status: "refresh_pending",
            ageSeconds: 30 * MINUTE_SECONDS,
          },
        },
      });
      expect(result.exit).toBe(0);
      passes(result.stdout);
    });
    test("fails a pending refresh whose answer arrives after the window closed", async () => {
      const result = await run({
        scenario: {
          nowEpoch: busyWindowEnd - MINUTE_SECONDS,
          nowEpochAfterCoverage: busyWindowEnd + MINUTE_SECONDS,
          coverage: {
            status: "refresh_pending",
            ageSeconds: busyWindowEnd - busyWindowStart,
          },
        },
      });
      expect(result.exit).toBe(1);
      fails(result.stdout);
    });
  });
  test("rotates the searched country by slot on the web and MCP", async () => {
    const result = await run({
      scenario: {
        searchSlot: "8",
        html: '<h1>Fixture</h1><a href="/law/hun/cases/fixture">case</a><a href="/law/cze/statutes/fixture">statute</a><article>text</article>',
      },
    });
    expect(result.exit).toBe(0);
    expect(result.calls.at(0)?.args).toEqual({
      queries: ["szerződés"],
      country: "HUN",
      limit: 1,
    });
    expect(result.searchUrls).toEqual([
      "/law/cases?q=szerz%C5%91d%C3%A9s&country=hun",
    ]);
  });
  test("accepts SSE envelopes", async () => {
    expect((await run({ scenario: { rpc: "sse" } })).exit).toBe(0);
  });
  test("runs journeys when the installed CLI meets the promoted target", async () => {
    const result = await run({ mode: "cli" });
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ passed ok/gu)).toHaveLength(3);
    expect(result.installClean).toBe(true);
    expect(result.counts.get("/versions")).toBeUndefined();
    expect(result.cliCalls).toContain(
      "case-law search --queries smlouva --country CZE --limit 1 --json",
    );
    expect(
      result.cliCalls.some((call) =>
        /^case-law read --decision-ids [0-9a-f-]{36} --json$/u.test(call),
      ),
    ).toBe(true);
  });
  test("fails all CLI journeys after the publication deadline", async () => {
    const result = await run({
      // A full grace period past the deadline: the checker reads the clock
      // when it starts and the fake release is stamped later, so a margin of
      // seconds would depend on how slowly the runner starts the checker.
      scenario: { cliVersion: "2.0.0", promotionAgeSeconds: 2 * DAY_SECONDS },
      mode: "cli",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("cli_version failed publish_lagging");
    expect(result.counts.get("/cli/search")).toBeUndefined();
  });
  test("skips all CLI journeys during promotion grace with target and deadline", async () => {
    const result = await run({
      mode: "cli",
      scenario: { cliVersion: "2.0.0" },
    });
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/skipped pending_release/gu)).toHaveLength(3);
    expect(
      result.stdout.match(/target 10\.0\.0; publication deadline /gu),
    ).toHaveLength(3);
    expect(result.counts.get("/cli/search")).toBeUndefined();
  });
  test("redacts credentials before bounding the first diagnostic line", async () => {
    const token = "secret.[+](literal)";
    const result = await run({
      mode: "cli",
      token,
      scenario: {
        cliExit: "1",
        cliDiagnostic: `failure ${token} Bearer unknown-bearer api_key=unknown-key token="unknown-token" ${"x".repeat(500)}\nsecond-private-line`,
      },
    });
    expect(result.stdout).toContain(
      "journey-detail cli_search failure [REDACTED]",
    );
    for (const secret of [
      token,
      "unknown-bearer",
      "unknown-key",
      "unknown-token",
      "second-private-line",
    ]) {
      expect(result.stdout).not.toContain(secret);
    }
    for (const line of result.stdout
      .split("\n")
      .filter((entry) => entry.startsWith("journey-detail "))) {
      expect(line.length).toBeLessThanOrEqual(440);
    }
  });
  test("identifies the failing payload check for CLI and MCP", async () => {
    for (const mode of ["cli", "web"] as const) {
      const result = await run({ mode, scenario: { rpc: "wrong-shape" } });
      expect(result.stdout).toContain(
        `journey-detail ${mode === "cli" ? "cli" : "mcp"}_search payload shape check: .results`,
      );
    }
  });
  test("contains install and command diagnostics", async () => {
    for (const scenario of [{ installExit: "1" }, { cliExit: "1" }]) {
      const result = await run({ scenario, mode: "cli" });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("failed contract_error");
    }
  });
  test("fails a valid CLI answer served from rejected registry fallback", async () => {
    const result = await run({
      scenario: {
        cliDiagnostic:
          "registry refresh rejected (using built-in commands): tool name is invalid: skill__fixture-name",
      },
      mode: "cli",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("cli_version passed ok");
    expect(result.stdout).toContain("cli_search failed registry_rejected");
    expect(result.stdout).toContain("cli_read failed registry_rejected");
  });
  test("names rejected registry fallback when the built-in command fails", async () => {
    const result = await run({
      scenario: {
        cliExit: "1",
        cliDiagnostic:
          "registry refresh rejected (using built-in commands): tool name is invalid: skill__fixture-name",
      },
      mode: "cli",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("cli_search failed registry_rejected");
    expect(result.stdout).toContain("cli_read failed registry_rejected");
  });
  test("keeps CLI payload faults as contract errors", async () => {
    const result = await run({
      scenario: {
        rpc: "wrong-shape",
        cliDiagnostic:
          "server registry differs from this CLI build: 5 removed, 1 changed",
      },
      mode: "cli",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("cli_search failed contract_error");
    expect(result.stdout).toContain("cli_read failed contract_error");
  });
  test("passes a CLI that only reports registry drift", async () => {
    const result = await run({
      scenario: {
        cliDiagnostic:
          "server registry differs from this CLI build: 5 removed, 1 changed",
      },
      mode: "cli",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ passed ok/gu)).toHaveLength(3);
  });
  test("classifies CLI credential rejection", async () => {
    for (const cliDiagnostic of ["401", "403", "key rejected"]) {
      const result = await run({
        scenario: { cliExit: "1", cliDiagnostic },
        mode: "cli",
      });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("cli_search failed auth_rejected");
      expect(result.stdout).toContain("cli_read failed auth_rejected");
    }
  });
  test("names authenticated CLI skips", async () => {
    const result = await run({ mode: "cli", token: "" });
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ skipped no_credential/gu)).toHaveLength(2);
  });
  test("compares desktop latest with stable tags numerically and checks installers", async () => {
    const result = await run({ mode: "desktop" });
    expect(result.exit).toBe(0);
    expect(result.counts.get("/assets/Stella-macos-universal.dmg")).toBe(1);
    expect(result.counts.get("/assets/Stella-windows-x64-setup.exe")).toBe(1);
    expect(
      (await run({ scenario: { latest: "v2.0.0" }, mode: "desktop" })).exit,
    ).toBe(1);
    expect(result.stdout).toBe("desktop-release-policy: ok\n");
  });
  test("allows a young draft while the newest desktop release is publishing", async () => {
    const result = await run({
      scenario: { latest: "v2.0.0", newestReleaseDraft: true },
      mode: "desktop",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("desktop-release-policy: publishing\n");
  });
  test("judges only the newest desktop run, so a rerun after a failure is still publishing", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        desktopWorkflowRuns: [
          {
            status: "in_progress",
            conclusion: null,
            created_at: "2026-10-09T09:40:00Z",
          },
          {
            status: "completed",
            conclusion: "failure",
            created_at: "2026-10-09T09:10:00Z",
          },
        ],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("desktop-release-policy: publishing\n");
  });
  test("allows a young in-progress run while the newest desktop release is publishing", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        desktopWorkflowStatus: "in_progress",
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("desktop-release-policy: publishing\n");
  });
  test("ignores an in-progress desktop run for another tag", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestTagCreatedAt: "2020-01-01T00:00:00Z",
        releaseWorkflowRuns: [],
        desktopWorkflowRuns: [
          {
            status: "in_progress",
            conclusion: null,
            created_at: "2026-10-09T09:00:00Z",
            display_title: "Desktop Release Artifacts v2.0.0",
          },
        ],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(
      "Desktop latest must match the newest stable application tag",
    );
  });
  test("finds a dispatched release run for the tag by its run name", async () => {
    const releaseRun = (display_title: string): WorkflowRun => ({
      status: "in_progress",
      conclusion: null,
      created_at: "2026-10-09T09:00:00Z",
      display_title,
    });
    const publishing = await run({
      scenario: {
        latest: "v2.0.0",
        newestTagCreatedAt: "2020-01-01T00:00:00Z",
        releaseWorkflowRuns: [releaseRun("Release Artifacts v10.0.0")],
        desktopWorkflowRuns: [],
      },
      mode: "desktop",
    });
    expect(publishing.exit).toBe(0);
    expect(publishing.stdout).toBe("desktop-release-policy: publishing\n");

    const otherTag = await run({
      scenario: {
        latest: "v2.0.0",
        newestTagCreatedAt: "2020-01-01T00:00:00Z",
        releaseWorkflowRuns: [releaseRun("Release Artifacts v2.0.0")],
        desktopWorkflowRuns: [],
      },
      mode: "desktop",
    });
    expect(otherTag.exit).toBe(1);
    expect(otherTag.stderr).toContain(
      "Desktop latest must match the newest stable application tag",
    );
  });
  test("fails on a failed release run for the tag", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        releaseWorkflowConclusion: "failure",
        desktopWorkflowRuns: [],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(
      "Desktop release workflow failed for the newest stable application tag",
    );
  });
  test("rejects an old newest release that is not latest", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseDraft: true,
        newestTagCreatedAt: "2020-01-01T00:00:00Z",
        releaseWorkflowRuns: [],
        desktopWorkflowRuns: [],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
  });
  test("rejects an annotated tag publishing time in the future", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseDraft: true,
        newestTagCreatedAt: "2026-10-09T11:00:00Z",
        releaseWorkflowRuns: [],
        desktopWorkflowRuns: [],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Newest stable application tag publishing time is in the future",
    );
  });
  test("allows publishing before the newest GitHub Release exists", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseStatus: 404,
        desktopWorkflowStatus: "in_progress",
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("desktop-release-policy: publishing\n");
  });
  test("rejects a lightweight tag with no release workflow or release", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseStatus: 404,
        newestTagType: "commit",
        releaseWorkflowRuns: [],
        desktopWorkflowRuns: [],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Newest stable application tag has no release workflow or annotated tag creation time",
    );
  });
  test("uses a young release workflow for a lightweight tag on an old commit", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseStatus: 404,
        newestTagType: "commit",
        releaseWorkflowRuns: [],
        desktopWorkflowRuns: [
          {
            status: "in_progress",
            conclusion: null,
            created_at: "2026-10-09T08:50:00Z",
          },
        ],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe("desktop-release-policy: publishing\n");
  });
  test("rejects a lightweight tag whose release workflow is outside the publishing window", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseStatus: 404,
        newestTagType: "commit",
        releaseWorkflowRuns: [],
        desktopWorkflowRuns: [
          {
            status: "in_progress",
            conclusion: null,
            created_at: "2026-10-09T05:00:00Z",
          },
        ],
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
  });
  test("rejects a failed release run before the newest release becomes latest", async () => {
    const result = await run({
      scenario: {
        latest: "v2.0.0",
        newestReleaseDraft: true,
        releaseWorkflowConclusion: "failure",
      },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
  });
  test("rejects completed release runs when the newest release is not latest", async () => {
    const result = await run({
      scenario: { latest: "v2.0.0" },
      mode: "desktop",
    });
    expect(result.exit).toBe(1);
  });
  test("reports an installer that passes only after its one retry", async () => {
    const result = await run({
      scenario: { firstAssetStatus: 503 },
      mode: "desktop",
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe(
      [
        "journey desktop_installer passed_after_retry http_status",
        "journey desktop_installer passed_after_retry http_status",
        "desktop-release-policy: ok",
        "",
      ].join("\n"),
    );
    expect(result.counts.get("/assets/Stella-macos-universal.dmg")).toBe(2);
    expect(result.counts.get("/assets/Stella-windows-x64-setup.exe")).toBe(2);
  });
  test("fails an installer after one retry", async () => {
    for (const assetStatus of [404, 503]) {
      const result = await run({ scenario: { assetStatus }, mode: "desktop" });
      expect(result.exit).toBe(1);
      expect(result.stdout).not.toContain("desktop-release-policy: ok");
      expect(result.counts.get("/assets/Stella-macos-universal.dmg")).toBe(2);
      expect(result.counts.get("/assets/Stella-windows-x64-setup.exe")).toBe(
        undefined,
      );
    }
  });
});

describe("case-law search probe", () => {
  type ProbeArgs = { queries: string[]; country: string; courts?: string[] };
  const probeArgs = (args: unknown) => {
    if (
      typeof args !== "object" ||
      args === null ||
      !("queries" in args) ||
      !Array.isArray(args.queries) ||
      !("country" in args)
    ) {
      throw new TypeError("not probe arguments");
    }
    return {
      queries: args.queries.map(String),
      country: String(args.country),
      ...("courts" in args && Array.isArray(args.courts)
        ? { courts: args.courts.map(String) }
        : {}),
    } satisfies ProbeArgs;
  };

  test("searches every country and two apex courts once, without retries", async () => {
    const result = await run({ mode: "search-probe" });
    expect(result.exit).toBe(0);
    expect(result.calls.map(({ name }) => name)).toEqual(
      Array.from({ length: 7 }, () => "search_case_law"),
    );
    const args = result.calls.map(({ args: call }) => probeArgs(call));
    expect(args.map(({ country }) => country)).toEqual([
      "CZE",
      "SVK",
      "POL",
      "HUN",
      "EU",
      "CZE",
      "POL",
    ]);
    expect(args.slice(0, 5).every(({ courts }) => courts === undefined)).toBe(
      true,
    );
    expect(args.at(5)?.courts).toEqual(["NS"]);
    expect(args.at(6)?.courts).toEqual(["SN"]);
    expect(result.stdout.match(/ passed ok/gu)).toHaveLength(7);
    expect(result.stdout).not.toContain("passed_after_retry");
  });

  test("asks something new in every slot of a day", async () => {
    const queries = new Set<string>();
    for (const probeSlot of ["0", "1", "20", "287", "288"]) {
      const result = await run({
        mode: "search-probe",
        scenario: { probeSlot },
      });
      expect(result.exit).toBe(0);
      const first = result.calls.at(0);
      expect(first).toBeDefined();
      queries.add(probeArgs(first?.args).queries.join(" "));
    }
    expect(queries.size).toBe(5);
  });

  test("fails without a retry when the first hit times out", async () => {
    const result = await run({
      mode: "search-probe",
      scenario: { probeError: "public_read_timeout" },
    });
    expect(result.exit).toBe(1);
    expect(result.calls).toHaveLength(7);
    expect(result.stdout).toContain("journey mcp_probe_cze failed timeout");
    expect(result.stdout).toContain("tool error public_read_timeout");
  });

  test("counts the timeout family and tells other tool errors apart", async () => {
    for (const code of [
      "upstream_unavailable",
      "search_index_unavailable",
      "public_read_unfinished",
      "continuation_expired",
    ]) {
      const result = await run({
        mode: "search-probe",
        scenario: { probeError: code },
      });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("journey mcp_probe_pol failed timeout");
    }
    const other = await run({
      mode: "search-probe",
      scenario: { probeError: "internal_error" },
    });
    expect(other.exit).toBe(1);
    expect(other.stdout).toContain(
      "journey mcp_probe_pol failed contract_error",
    );
  });

  test("follows a continuation once with the same arguments", async () => {
    const result = await run({
      mode: "search-probe",
      scenario: { probeRunning: "once" },
    });
    expect(result.exit).toBe(0);
    expect(result.calls).toHaveLength(14);
    expect(result.calls.at(1)?.args).toEqual({
      ...probeArgs(result.calls.at(0)?.args),
      limit: 3,
      continuation_token: "fixture-continuation",
    });
  });

  test("treats a search still running after its continuations as a timeout", async () => {
    const result = await run({
      mode: "search-probe",
      scenario: { probeRunning: "always" },
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("journey mcp_probe_cze failed timeout");
    expect(result.stdout).toContain("still running after 3 continuations");
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(30);
  });

  test("fails on a client-side timeout", async () => {
    const result = await run({
      mode: "search-probe",
      scenario: { delay: 500 },
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("failed timeout");
  });

  test("fails without credentials and asks nothing", async () => {
    const result = await run({ mode: "search-probe", token: "" });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("journey mcp_probe failed no_credential");
    expect(result.counts.get("/mcp")).toBeUndefined();
  });

  test("fails on a search the run budget skipped", async () => {
    const result = await run({
      mode: "search-probe",
      scenario: { probeRunSeconds: "-1" },
    });
    expect(result.exit).toBe(1);
    expect(result.calls).toHaveLength(0);
    expect(result.stdout.match(/ failed run_budget/gu)).toHaveLength(7);
  });

  test("follows no continuation once the run budget is spent", async () => {
    const result = await run({
      mode: "search-probe",
      scenario: { probeRunning: "always", probeRunSeconds: "0" },
    });
    expect(result.exit).toBe(1);
    expect(
      result.calls.every(
        ({ args }) =>
          typeof args === "object" &&
          args !== null &&
          !("continuation_token" in args),
      ),
    ).toBe(true);
  });
});

test("schedules bounded journeys and routes alerts", async () => {
  const workflow = await Bun.file(
    new URL("../.github/workflows/journey-canary.yml", import.meta.url),
  ).text();
  expect(workflow).toContain('cron: "11 * * * *"');
  expect(workflow).toContain('cron: "41 */6 * * *"');
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("timeout-minutes: 5");
  expect(workflow).toContain("contents: read");
  expect(workflow).toContain("group: journey-canary");
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).not.toMatch(/matrix:|bun ci|bun install/u);
  expect(workflow).toContain("persist-credentials: false");
  expect(workflow).not.toContain("no-cache: true");
  expect(workflow).toContain("&& '0' || '1'");
  expect(workflow).toContain("bun scripts/check-published-versions.ts");
  expect(workflow).toContain("bash scripts/check-journeys.sh --cli");
  expect(
    workflow.match(/github.event.schedule == '41 \*\/6 \* \* \*'/gu),
  ).toHaveLength(4);
  for (const action of workflow.matchAll(/uses: (\S+)/gu)) {
    expect(action[1]).toMatch(/@[0-9a-f]{40}$/u);
  }
  const alerts = await Bun.file(
    new URL("../.github/workflows/scheduled-run-alerts.yml", import.meta.url),
  ).text();
  expect(alerts).toContain("- Journey canary");
  expect(alerts).toContain('".github/workflows/journey-canary.yml"');
  expect(alerts).toContain("- Case-law search probe");
  expect(alerts).toContain('".github/workflows/case-law-search-probe.yml"');
  const probe = await Bun.file(
    new URL("../.github/workflows/case-law-search-probe.yml", import.meta.url),
  ).text();
  expect(probe).toContain("vars.CASE_LAW_SEARCH_PROBE_ENABLED == 'true'");
  expect(probe).toContain("persist-credentials: false");
  expect(probe).toContain(
    "bash scripts/retry.sh bash scripts/check-journeys.sh --search-probe",
  );
  expect(probe).toContain('RETRY_PASSTHROUGH_EXIT_CODES: "1"');
  for (const action of probe.matchAll(/uses: (\S+)/gu)) {
    expect(action[1]).toMatch(/@[0-9a-f]{40}$/u);
  }
});

test("redacts known credential values literally and strips terminal controls", async () => {
  const secrets = {
    JOURNEY_DETAIL_CREDENTIAL: "canary.[+](secret)",
    STELLA_API_KEY: "api.[+](secret)",
    GITHUB_TOKEN: "github.[+](secret)",
    GH_TOKEN: "gh.[+](secret)",
    JOURNEY_DETAIL_SESSION: "session.[+](secret)",
  };
  const child = Bun.spawn(["jq", "-Rrs", "-f", "scripts/journey-detail.jq"], {
    cwd: ROOT,
    env: { ...process.env, ...secrets },
    stdin: new TextEncoder().encode(
      `\u001b[31m${Object.values(secrets).join(" ")}\r\nprivate second line`,
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  expect(output.match(/\[REDACTED\]/gu)).toHaveLength(5);
  for (const secret of Object.values(secrets)) {
    expect(output).not.toContain(secret);
  }
  expect(output).not.toContain("\u001b");
  expect(output).not.toContain("\r");
  expect(output).not.toContain("private second line");
});
