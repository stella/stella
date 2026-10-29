import { expect, spyOn, test } from "bun:test";

import { readApiDeployment } from "./check-api-deployment";
import { readStagingReadiness } from "./staging-proof-readiness-cli";

const COMMIT = "a".repeat(40);

const options = (url: URL) => ({
  url,
  headers: new Headers(),
  expectedCommit: COMMIT,
  timeoutMs: 1000,
});

test("a healthy response from the expected commit is ready", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json({
        status: "ok",
        commit: COMMIT,
        deployEnvironment: "staging",
      }),
  });
  try {
    expect(await readStagingReadiness(options(server.url))).toEqual({
      status: "ready",
    });
  } finally {
    await server.stop(true);
  }
});

for (const fixture of [
  {
    name: "a non-200 response",
    status: 503,
    body: JSON.stringify({
      status: "ok",
      commit: COMMIT,
      deployEnvironment: "staging",
    }),
  },
  {
    name: "a non-200 success response",
    status: 201,
    body: JSON.stringify({
      status: "ok",
      commit: COMMIT,
      deployEnvironment: "staging",
    }),
  },
  {
    name: "a missing deployment environment",
    status: 200,
    body: JSON.stringify({ status: "ok", commit: COMMIT }),
  },
  {
    name: "a different deployment environment",
    status: 200,
    body: JSON.stringify({
      status: "ok",
      commit: COMMIT,
      deployEnvironment: "production",
    }),
  },
  { name: "malformed JSON", status: 200, body: "not JSON" },
  {
    name: "an unexpected commit",
    status: 200,
    body: JSON.stringify({
      status: "ok",
      commit: "b".repeat(40),
      deployEnvironment: "staging",
    }),
    rejection: {
      reason: "commit mismatch",
      commit: "b".repeat(40),
      status: "ready",
    },
  },
  {
    name: "an unhealthy status",
    status: 200,
    body: JSON.stringify({
      status: "unavailable",
      commit: COMMIT,
      deployEnvironment: "staging",
    }),
    rejection: { reason: "health status", commit: COMMIT, status: "not-ready" },
  },
  {
    name: "a missing commit",
    status: 200,
    body: JSON.stringify({ status: "ok" }),
  },
  { name: "a null payload", status: 200, body: "null" },
  { name: "an array payload", status: 200, body: "[]" },
]) {
  test(`${fixture.name} is not ready`, async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(fixture.body, { status: fixture.status }),
    });
    try {
      if ("rejection" in fixture) {
        const probe = await readApiDeployment({
          url: server.url,
          expectedEnvironment: "staging",
        });
        expect(probe, fixture.rejection.reason).toMatchObject({
          statusCode: 200,
          commit: fixture.rejection.commit,
          status: fixture.rejection.status,
        });
      }
      expect(
        await readStagingReadiness(options(server.url)),
        "rejection" in fixture ? fixture.rejection.reason : fixture.name,
      ).toEqual({ status: "not-ready" });
    } finally {
      await server.stop(true);
    }
  });
}

test("a response that does not finish before its timeout is not ready", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(new ReadableStream()),
  });
  try {
    expect(
      await readStagingReadiness({ ...options(server.url), timeoutMs: 10 }),
    ).toEqual({ status: "not-ready" });
  } finally {
    await server.stop(true);
  }
});

test("edge access headers reach the server without appearing in output", async () => {
  const edgeHeader = "x-fixture-edge-access";
  const edgeValue = "fixture-header-value";
  const received: (string | null)[] = [];
  const logged = spyOn(console, "log").mockImplementation(() => undefined);
  const errors = spyOn(console, "error").mockImplementation(() => undefined);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      received.push(request.headers.get(edgeHeader));
      return new Response(edgeValue, { status: 503 });
    },
  });
  try {
    const outcome = await readStagingReadiness({
      ...options(server.url),
      headers: new Headers({ [edgeHeader]: edgeValue }),
    });
    expect(received).toEqual([edgeValue]);
    expect(outcome).toEqual({ status: "not-ready" });
    expect(logged).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await server.stop(true);
    logged.mockRestore();
    errors.mockRestore();
  }
});

const runFault = async (fault: string) => {
  const { mkdtemp, mkdir, rm, writeFile, readFile } =
    await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const directory = await mkdtemp(
    path.resolve(import.meta.dir, "../.proof-cli-test-"),
  );
  const statePath = path.join(directory, "state.json");
  const output = path.join(directory, "output");
  const summary = path.join(directory, "summary");
  const env = {
    PATH: process.env["PATH"] ?? "",
    STAGING_PROOF_STATE_PATH: statePath,
    STAGING_PROOF_PREFLIGHT: "ready",
    E2E_API_URL: "https://example.invalid",
    EXPECTED_COMMIT: COMMIT,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
  };
  let mode = "finish";
  try {
    if (fault === "malformed-state") {
      await writeFile(statePath, "not JSON");
    } else if (fault === "invalid-state") {
      await writeFile(statePath, JSON.stringify({ status: "unknown" }));
    } else if (fault === "report-output" || fault === "report-summary") {
      await writeFile(statePath, JSON.stringify({ status: "ready" }));
      await mkdir(fault === "report-output" ? output : summary);
    } else if (fault === "invalid-url") {
      mode = "wait";
      env.E2E_API_URL = "invalid\n::warning::untrusted";
    } else if (fault === "unknown-mode") {
      mode = "unknown";
    } else if (fault === "monitor-write") {
      mode = "monitor";
      env.STAGING_PROOF_STATE_PATH = path.join(directory, "absent", "state");
    }
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "staging-proof-readiness-cli.ts"),
        mode,
      ],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(80);
    expect(stdout).toContain(
      "::error title=proof-tooling-failure::Staging proof tooling failed;",
    );
    expect(stdout).not.toContain("::warning::untrusted");
    expect(stdout).not.toContain("rerun");
    expect(stderr).toBe("");
    if (fault !== "report-output" && fault !== "report-summary") {
      expect(await readFile(output, "utf-8")).toBe(
        "status=proof-tooling-failure\n",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

for (const fault of [
  "missing-state",
  "malformed-state",
  "invalid-state",
  "report-output",
  "report-summary",
  "invalid-url",
  "unknown-mode",
  "monitor-write",
]) {
  test(`${fault} produces a proof tooling failure with a fixed diagnostic`, async () => {
    await runFault(fault);
  });
}

test("current deployment initialization failures stop proof with an escaped summary", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { default: path } = await import("node:path");
  const directory = await mkdtemp(
    path.resolve(import.meta.dir, "../.proof-ecs-test-"),
  );
  const statePath = path.join(directory, "state.json");
  const summary = path.join(directory, "summary");
  const output = path.join(directory, "output");
  const reason = "ResourceInitializationError: <registry>\n::warning::fixture%";
  try {
    await writeFile(
      `${statePath}.ecs.json`,
      JSON.stringify({
        commit: COMMIT,
        scope: ["api"],
        services: [
          {
            service: "api",
            deploymentId: "ecs-svc/current",
            tasks: [
              { startedBy: "ecs-svc/current", lastStatus: "RUNNING" },
              {
                startedBy: "ecs-svc/current",
                lastStatus: "STOPPED",
                stoppedReason: reason,
              },
            ],
          },
        ],
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "staging-proof-readiness-cli.ts"),
        "wait",
      ],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          STAGING_PROOF_STATE_PATH: statePath,
          EXPECTED_COMMIT: COMMIT,
          E2E_API_URL: "https://example.invalid",
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(78);
    expect(await readFile(output, "utf-8")).toBe(
      "status=environment-unavailable\n",
    );
    const report = await readFile(summary, "utf-8");
    expect(report).toContain("ResourceInitializationError: &lt;registry&gt;");
    expect(report).toContain("rerun");
    expect(stdout).not.toContain("::warning::fixture");
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const status of ["ok", "unavailable"]) {
  test(`preflight uses the deployment checker's stable readiness probes for ${status}`, async () => {
    const { mkdtemp, readFile, rm, writeFile } =
      await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const directory = await mkdtemp(
      path.resolve(import.meta.dir, "../.proof-wait-test-"),
    );
    const statePath = path.join(directory, "state.json");
    const output = path.join(directory, "output");
    let reads = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        expect(new URL(request.url).pathname).toBe("/ready");
        expect(request.headers.get("x-fixture-edge-token")).toBe(
          "fixture-access-token",
        );
        reads += 1;
        return Response.json({
          status,
          commit: COMMIT,
          deployEnvironment: "staging",
        });
      },
    });
    try {
      await writeFile(
        `${statePath}.ecs.json`,
        JSON.stringify({
          commit: COMMIT,
          scope: ["api"],
          services: [
            {
              service: "api",
              deploymentId: "ecs-svc/current",
              tasks: [{ startedBy: "ecs-svc/current", lastStatus: "RUNNING" }],
            },
          ],
        }),
      );
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "staging-proof-readiness-cli.ts"),
          "wait",
        ],
        {
          env: {
            PATH: process.env["PATH"] ?? "",
            STAGING_PROOF_STATE_PATH: statePath,
            EXPECTED_COMMIT: COMMIT,
            E2E_API_URL: server.url.toString(),
            E2E_EDGE_HEADER_NAME: "x-fixture-edge-token",
            E2E_EDGE_HEADER_VALUE: "fixture-access-token",
            API_DEPLOYMENT_ATTEMPTS: "5",
            API_DEPLOYMENT_DELAY_MS: "1",
            GITHUB_OUTPUT: output,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(reads).toBe(5);
      expect(exitCode, stderr).toBe(status === "ok" ? 0 : 78);
      expect(await readFile(output, "utf-8")).toBe(
        `status=${status === "ok" ? "ready" : "environment-unavailable"}\n`,
      );
      expect(stdout).not.toContain("fixture-access-token");
      expect(stderr).not.toContain("fixture-access-token");
    } finally {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
