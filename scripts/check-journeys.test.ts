import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as v from "valibot";

import type {
  READ_CASE_LAW_DECISION_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
  SEARCH_LEGISLATION_PROJECTION,
} from "../apps/api/src/lib/chat/projections";

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
    | "absent-decision";
  cliVersion?: string;
  cliExit?: string;
  cliDiagnostic?: string;
  installExit?: string;
  tags?: string[];
  latest?: string;
  assetStatus?: number;
  firstAssetStatus?: number;
  session?: "required" | "notification-error";
  redirect?: "once" | "chain";
};

type McpPayloadOptions = { name: string; rpc: Scenario["rpc"] };
const mcpPayload = ({ name, rpc }: McpPayloadOptions) => {
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

const assetStatusFor = (scenario: Scenario, attempt: number | undefined) =>
  attempt === 1 && scenario.firstAssetStatus
    ? scenario.firstAssetStatus
    : (scenario.assetStatus ?? 200);

type RunOptions = {
  scenario?: Scenario;
  mode?: "web" | "cli" | "desktop";
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
  let initialized = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
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
          (scenario.tags ?? ["v2.0.0", "v10.0.0", "v11.0.0-beta.1"]).map(
            (tag) => ({ ref: `refs/tags/${tag}` }),
          ),
        );
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
        const payload = mcpPayload({
          name: body.params.name,
          rpc: scenario.rpc,
        });
        result = {
          isError: scenario.rpc === "tool-error",
          content: [
            {
              type: "text",
              text: JSON.stringify(
                scenario.rpc === "wrong-shape"
                  ? { unrelated: SENTINEL }
                  : payload,
              ),
            },
          ],
        };
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
      `#!/usr/bin/env bash\nif [[ -n "\${MCP_CANARY_TOKEN:-}" || -n "\${STELLA_API_KEY:-}" || " $* " != *" --ignore-scripts "* ]]; then exit 1; fi\necho clean > "$INSTALL_CHECK"\necho '${SENTINEL}' >&2\nif [[ "$INSTALL_EXIT" != 0 ]]; then exit "$INSTALL_EXIT"; fi\nwhile [[ "$1" != --prefix ]]; do shift; done\nmkdir -p "$2/bin"\ncp "$CLI_FIXTURE" "$2/bin/stella"\n`,
    );
    await Bun.write(
      path.join(work, "stella"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CLI_CALL_LOG"\nprintf '%s\\n' "$CLI_DIAGNOSTIC" >&2\necho '${SENTINEL}' >&2\nif [[ "$1" == --version ]]; then if [[ -n "\${MCP_CANARY_TOKEN:-}" || -n "\${STELLA_API_KEY:-}" ]]; then exit 1; fi; printf '%s\\n' "$CLI_VERSION"; exit 0; fi\nif [[ "$CLI_EXIT" != 0 ]]; then exit "$CLI_EXIT"; fi\ncurl -sS -H "Authorization: Bearer $STELLA_API_KEY" "$STELLA_SERVER_URL/cli/$2"\n`,
    );
    await Bun.write(
      path.join(work, "git"),
      `#!/usr/bin/env bash\nif [[ "$*" != "tag --list @stll/cli@*" ]]; then exit 1; fi\nprintf '%s\\n' '@stll/cli@2.0.0' '@stll/cli@10.0.0' '@stll/cli@11.0.0-beta.1'\n`,
    );
    await Bun.write(
      path.join(work, "gh"),
      `#!/usr/bin/env bash\nif [[ "$2" == --paginate ]]; then route=tags; else route=latest; fi\ncurl -fsS "$FAKE_SERVER/desktop/$route"\n`,
    );
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
          STELLA_DESKTOP_RETRY_PAUSE_SECONDS: "0",
          JOURNEY_TIMEOUT_SECONDS: scenario.delay ? "0.1" : "3",
          CLI_FIXTURE: path.join(work, "stella"),
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
      for (const line of stdout.trim().split("\n")) {
        expect(line).toMatch(
          /^journey [a-z_]+ (passed|passed_after_retry|failed|skipped) (http_status|timeout|missing_marker|empty_result|contract_error|version_mismatch|registry_rejected|no_credential|auth_rejected|ok)$/u,
        );
      }
    }
    const cliCalls = (await Bun.file(path.join(work, "cli-calls")).text())
      .trim()
      .split("\n");
    const installClean = await Bun.file(
      path.join(work, "install-check"),
    ).exists();
    return { stdout, exit, counts, calls, cliCalls, installClean };
  } finally {
    await server.stop(true);
    await rm(work, { recursive: true, force: true });
  }
};

describe("scheduled read journeys", () => {
  test("reports each public and authenticated probe", async () => {
    const result = await run();
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ passed /gu)).toHaveLength(7);
    expect(result.calls.map(({ name }) => name)).toEqual([
      "search_case_law",
      "read_case_law_decision",
      "search_legislation",
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
    ).toBe(7);
  });
  test("names all skips without credentials", async () => {
    const result = await run({ token: "" });
    expect(result.exit).toBe(0);
    expect(result.stdout.match(/ skipped no_credential/gu)).toHaveLength(4);
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
    ).toBe(10);
  });
  test("counts a bounded public redirect", async () => {
    const result = await run({ scenario: { redirect: "once" } });
    expect(result.exit).toBe(0);
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBe(8);
    const chain = await run({ scenario: { redirect: "chain" } });
    expect(chain.exit).toBe(1);
    expect(chain.stdout).toContain("web_statutes failed http_status");
    expect(
      [...chain.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(10);
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
      ).toBeLessThanOrEqual(10);
    });
  }
  test("negotiates a session and initializes it before tools", async () => {
    const result = await run({ scenario: { session: "required" } });
    expect(result.exit).toBe(0);
    expect(result.stdout).not.toContain("fixture-session");
    expect(result.counts.get("/mcp")).toBe(5);
  });
  test("reports initialization notification failures", async () => {
    const result = await run({ scenario: { session: "notification-error" } });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("mcp_initialize failed http_status");
    expect(
      [...result.counts.values()].reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(10);
  });
  test("accepts SSE envelopes", async () => {
    expect((await run({ scenario: { rpc: "sse" } })).exit).toBe(0);
  });
  test("uses the newest stable CLI publication tag", async () => {
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
  test("classifies CLI version disagreement", async () => {
    const result = await run({
      scenario: { cliVersion: "2.0.0" },
      mode: "cli",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("cli_version failed version_mismatch");
    expect(result.counts.get("/cli/search")).toBeUndefined();
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
  expect(workflow).toContain("no-cache: true");
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
});
