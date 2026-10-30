import { existsSync } from "node:fs";
import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { readApiDeployment } from "./check-api-deployment";
import { readStagingEcsReadiness } from "./staging-ecs-readiness";
import {
  monitorStagingReadiness,
  type ReadinessMonitorOutcome,
  type ReadinessSample,
} from "./staging-proof-readiness";

const MONITOR_DEADLINE_MS = 180 * 60_000;
const FINISH_DEADLINE_MS = 45_000;
const SAMPLE_INTERVAL_MS = 10_000;
const READ_TIMEOUT_MS = 10_000;

type ReadStagingReadinessOptions = {
  url: URL;
  headers: Headers;
  expectedCommit: string;
  timeoutMs: number;
};

// Kept dependency-free so the workflow can preserve its own tooling across checkout.
export const readStagingReadiness = async ({
  url,
  headers,
  expectedCommit,
  timeoutMs,
}: ReadStagingReadinessOptions): Promise<ReadinessSample> => {
  try {
    const probe = await readApiDeployment({
      url,
      headers,
      timeoutMs,
      expectedEnvironment: "staging",
    });
    return {
      status:
        probe.statusCode === 200 && probe.commit === expectedCommit
          ? probe.status
          : "not-ready",
    };
  } catch {
    return { status: "not-ready" };
  }
};

type ProofStatus =
  | "environment-unavailable"
  | ReadinessMonitorOutcome["status"]
  | "proof-tooling-failure";
type MonitorState =
  | { status: "monitoring" }
  | ReadinessMonitorOutcome
  | { status: "proof-tooling-failure" };

const readMonitorState = async (statePath: string): Promise<MonitorState> => {
  const body: unknown = JSON.parse(await readFile(statePath, "utf-8"));
  if (typeof body === "object" && body !== null) {
    const status = Reflect.get(body, "status");
    if (
      status === "monitoring" ||
      status === "ready" ||
      status === "environment-interrupted" ||
      status === "proof-tooling-failure"
    ) {
      return { status };
    }
  }
  return { status: "proof-tooling-failure" };
};

const writeMonitorState = async (statePath: string, state: MonitorState) => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state));
  await rename(temporary, statePath);
};

const toolingFailureMessage =
  "Staging proof tooling failed; inspect the proof tooling configuration and logs.";

const annotationData = (value: string) =>
  value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const report = async (status: ProofStatus, detail = "") => {
  const message = {
    ready: "Staging proof environment is ready.",
    "environment-unavailable":
      "Staging proof environment unavailable; rerun after readiness recovers.",
    "environment-interrupted":
      "Environment interrupted during proof; rerun the staging proof.",
    "proof-tooling-failure": toolingFailureMessage,
  } as const satisfies Record<ProofStatus, string>;
  const line = message[status];
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary !== undefined) {
    await appendFile(
      summary,
      `${line}\n${detail === "" ? "" : `<pre>${detail.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>\n`}`,
    );
  }
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined) {
    await appendFile(output, `status=${status}\n`);
  }
  if (status === "ready") {
    console.log(line);
    return 0;
  }
  console.log(`::error title=${status}::${annotationData(line)}`);
  const exitCodes = {
    ready: 0,
    "environment-unavailable": 78,
    "environment-interrupted": 79,
    "proof-tooling-failure": 80,
  } as const satisfies Record<ProofStatus, number>;
  return exitCodes[status];
};

const finishMonitor = async (statePath: string): Promise<ProofStatus> => {
  await writeFile(`${statePath}.stop`, "finish");
  const deadline = performance.now() + FINISH_DEADLINE_MS;
  while (performance.now() < deadline) {
    const state = await readMonitorState(statePath);
    if (state.status !== "monitoring") {
      return state.status;
    }
    await Bun.sleep(250);
  }
  return "environment-interrupted";
};

const run = async (): Promise<number> => {
  const mode = process.argv.at(2);
  const statePath = process.env["STAGING_PROOF_STATE_PATH"];
  if (statePath === undefined) {
    return await report("proof-tooling-failure");
  }
  if (mode !== "wait" && mode !== "monitor" && mode !== "finish") {
    return await report("proof-tooling-failure");
  }
  if (mode === "finish") {
    const preflight = process.env["STAGING_PROOF_PREFLIGHT"];
    if (preflight === "ready") {
      return await report(await finishMonitor(statePath));
    }
    return await report(
      preflight === "environment-unavailable"
        ? "environment-unavailable"
        : "proof-tooling-failure",
    );
  }
  const apiUrl = process.env["E2E_API_URL"];
  const expectedCommit = process.env["EXPECTED_COMMIT"];
  if (
    apiUrl === undefined ||
    expectedCommit === undefined ||
    !/^[a-f0-9]{40}$/u.test(expectedCommit)
  ) {
    return await report("proof-tooling-failure");
  }
  const url = new URL("/ready", apiUrl);
  const headers = new Headers();
  const edgeName = process.env["E2E_EDGE_HEADER_NAME"];
  const edgeValue = process.env["E2E_EDGE_HEADER_VALUE"];
  if (edgeName !== undefined && edgeValue !== undefined) {
    headers.set(edgeName, edgeValue);
  }
  const controller = new AbortController();
  const read = async ({ timeoutMs }: { timeoutMs: number }) =>
    await readStagingReadiness({ url, headers, expectedCommit, timeoutMs });
  const options = {
    read,
    now: () => performance.now(),
    sleep: async (durationMs: number) => {
      await Bun.sleep(durationMs);
      if (mode === "monitor" && existsSync(`${statePath}.stop`)) {
        controller.abort();
      }
    },
    intervalMs: SAMPLE_INTERVAL_MS,
    readTimeoutMs: READ_TIMEOUT_MS,
  };
  if (mode === "wait") {
    await Promise.all([
      rm(statePath, { force: true }),
      rm(`${statePath}.stop`, { force: true }),
    ]);
    const ecs = await readStagingEcsReadiness(
      `${statePath}.ecs.json`,
      expectedCommit,
    );
    if (ecs.status === "environment-unavailable") {
      return await report(ecs.status, ecs.reason);
    }
    if (ecs.status === "unrecorded") {
      // A present receipt is checked strictly; an absent one is never silent.
      console.log(
        `::warning title=receipt-unrecorded::${annotationData(ecs.reason)}`,
      );
      const summary = process.env["GITHUB_STEP_SUMMARY"];
      if (summary !== undefined) {
        await appendFile(summary, `WARNING: ${ecs.reason}\n`);
      }
    }
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("check-api-deployment.ts", import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          API_DEPLOYMENT_URL: apiUrl,
          API_DEPLOYMENT_EXPECTED_COMMIT: expectedCommit,
          API_DEPLOYMENT_EXPECTED_ENVIRONMENT: "staging",
          API_DEPLOYMENT_PROBE_PATH: "ready",
          EDGE_HEADER_NAME: edgeName,
          EDGE_HEADER_VALUE: edgeValue,
        },
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return await report(
      (await child.exited) === 0 ? "ready" : "environment-unavailable",
    );
  }
  await writeMonitorState(statePath, { status: "monitoring" });
  const outcome = await monitorStagingReadiness({
    ...options,
    deadlineMs: performance.now() + MONITOR_DEADLINE_MS,
    signal: controller.signal,
  });
  await writeMonitorState(statePath, outcome);
  return 0;
};

if (import.meta.main) {
  try {
    process.exitCode = await run();
  } catch {
    process.exitCode = 80;
    // Reporting and monitor persistence can fail independently of the gate.
    console.log(
      `::error title=proof-tooling-failure::${annotationData(toolingFailureMessage)}`,
    );
    const statePath = process.env["STAGING_PROOF_STATE_PATH"];
    const reports = await Promise.allSettled([
      report("proof-tooling-failure"),
      ...(process.argv.at(2) === "monitor" && statePath !== undefined
        ? [writeMonitorState(statePath, { status: "proof-tooling-failure" })]
        : []),
    ]);
    if (reports.some((result) => result.status === "rejected")) {
      console.log(
        `::error title=proof-tooling-failure::${annotationData(toolingFailureMessage)}`,
      );
    }
  }
}
