import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generatedInputTreeHash } from "../packages/scripts/src/generated-input-identity";
import { createSha256, sha256Hex } from "../packages/sha256/src/bun";
import {
  classifiedChecks,
  downloadReceipt,
  passedStaticChecks,
  reusableStaticReceipt,
  resolveStaticReuse,
  runStaticReceiptBoundary,
  STATIC_RECEIPT_STEP_NAMES,
  staticCheckKey,
  staticReuseOutputs,
  staticReuseCondition,
  trustedQueueRun,
} from "./ci-static-checks";
import { workflowJobSteps } from "./workflow-steps";

const workflow: unknown = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  ),
);
const jobs = ["ci-checks-policy", "ci-checks-rest"];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

test("every partition task declares its inputs or contextual dependency and exact reuse gate", () => {
  for (const job of jobs) {
    const steps = workflowJobSteps(workflow, job);
    const classified = classifiedChecks(workflow, job);
    expect(classified.length).toBeGreaterThan(20);
    for (const step of classified) {
      const env = step["env"];
      if (!record(env)) {
        expect.unreachable("Missing task environment");
      }
      const gate = ` && (github.event_name == 'merge_group' || steps.static_receipts.outputs.reuse_${String(step["id"])} != 'true')`;
      switch (env["CI_CHECK_KIND"]) {
        case "STATIC":
          expect(step["if"]).toContain(gate);
          expect(steps.indexOf(step)).toBeGreaterThan(
            steps.findIndex(
              (candidate) => candidate["id"] === "static_receipts",
            ),
          );
          break;
        case "CONTEXTUAL":
          expect(String(step["if"])).not.toMatch(
            /outputs\.reuse_.* != 'true'/u,
          );
          expect(String(env["CI_CHECK_CONTEXT"]).length).toBeGreaterThan(0);
          break;
        default:
          expect.unreachable("Unclassified task");
      }
    }
    for (const name of STATIC_RECEIPT_STEP_NAMES) {
      expect(steps.filter((step) => step["name"] === name)).toHaveLength(1);
    }
    const resolve = steps.find((step) => step["id"] === "static_receipts");
    expect(
      steps.findIndex((step) => step["name"] === "Setup Bun"),
    ).toBeLessThan(steps.indexOf(resolve ?? {}));
    const produce = steps.find(
      (step) => step["id"] === "static_receipt_record",
    );
    expect(produce?.["if"]).toContain(
      "success() && github.event_name == 'merge_group'",
    );
    const publish = steps.find(
      (step) => step["name"] === "Publish static check receipts",
    );
    expect(publish?.["if"]).toContain("github.event_name == 'merge_group'");
    expect(publish?.["if"]).toContain("outputs.recorded == 'true'");
  }
});

const temporaryFiles = (step: Record<string, unknown>) => {
  const files = new Set<string>();
  const text = JSON.stringify(step).replaceAll(
    /\$\{\{\s*runner\.temp\s*\}\}/gu,
    "$RUNNER_TEMP",
  );
  for (const match of text.matchAll(/\$RUNNER_TEMP\/[a-zA-Z0-9_.*/-]+/gu)) {
    files.add(match[0]);
  }
  return files;
};

// Follow file and step-output consumers through reports to their uploads.
// A later reader must either require actual execution or declare reuse handling.
test("every downstream reader of a reusable check handles reuse or requires execution", () => {
  for (const job of jobs) {
    const steps = classifiedChecks(workflow, job);
    for (const [index, producer] of steps.entries()) {
      const env = producer["env"];
      if (!record(env) || env["CI_CHECK_KIND"] !== "STATIC") {
        continue;
      }
      const id = String(producer["id"]);
      const files = temporaryFiles(producer);
      const sourceIds = new Set([id]);
      for (const reader of steps.slice(index + 1)) {
        const inputs = temporaryFiles(reader);
        const text = JSON.stringify(reader);
        if (
          ![...inputs].some((file) => files.has(file)) &&
          ![...sourceIds].some((source) =>
            text.includes(`steps.${source}.outputs.`),
          )
        ) {
          continue;
        }
        const condition = String(reader["if"]);
        if (condition.includes(`steps.${id}.outcome == 'success'`)) {
          continue;
        }
        const readerEnv = reader["env"];
        expect(record(readerEnv)).toBe(true);
        if (!record(readerEnv)) {
          throw new TypeError("Missing reader reuse declaration");
        }
        expect(readerEnv["CI_CHECK_REUSE_SOURCE"]).toBe(id);
        expect(readerEnv["CI_STATIC_REUSED"]).toBe(
          `\${{ steps.static_receipts.outputs.reuse_${id} }}`,
        );
        expect(readerEnv["CI_STATIC_RECEIPT_RUN_ID"]).toBe(
          `\${{ steps.static_receipts.outputs.receipt_run_${id} }}`,
        );
        for (const file of inputs) {
          files.add(file);
        }
        if (typeof reader["id"] === "string") {
          sourceIds.add(reader["id"]);
        }
      }
    }
  }
});

test("required parity reuse reports the verified receipt run without reading an execution log", () => {
  const steps = workflowJobSteps(workflow, "ci-checks-rest");
  const parity = steps.find((step) => step["id"] === "typecheck_parity");
  if (!parity) {
    return;
  } // Dispatch-only parity can move out of these partitions.
  const report = steps.find(
    (step) => step["name"] === "Record typecheck parity report",
  );
  const upload = steps.find(
    (step) => step["name"] === "Upload typecheck parity report",
  );
  expect(String(report?.["if"])).toContain(
    "steps.typecheck_parity_gate.outputs.required == 'true'",
  );
  expect(String(parity["if"])).toContain(
    staticReuseCondition("typecheck_parity"),
  );
  const directory = mkdtempSync(path.join(tmpdir(), "static-parity-report-"));
  try {
    writeFileSync(path.join(directory, "CLOUD_REPORT.md"), "Parity report\n");
    const run = report?.["run"];
    if (typeof run !== "string") {
      throw new TypeError("Missing parity report command");
    }
    const child = Bun.spawnSync(["bash", "-e", "-c", run], {
      cwd: directory,
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        CI_STATIC_REUSED: "true",
        CI_STATIC_RECEIPT_RUN_ID: "42",
      },
    });
    expect(child.exitCode).toBe(0);
    expect(
      readFileSync(path.join(directory, "CLOUD_REPORT.md"), "utf-8"),
    ).toContain("Reused typecheck parity from receipt run 42.");
    const withOptions = upload?.["with"];
    expect(record(withOptions) && withOptions["path"]).toBe(
      `\${{ runner.temp }}/CLOUD_REPORT.md`,
    );
    expect(staticReuseOutputs([{ id: "typecheck_parity", runId: 42 }])).toBe(
      "reuse_typecheck_parity=true\nreceipt_run_typecheck_parity=42\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new or incomplete task declarations fail the census", () => {
  const fixture = (step: object) => ({ jobs: { fixture: { steps: [step] } } });
  expect(() =>
    classifiedChecks(fixture({ name: "New", run: "true" }), "fixture"),
  ).toThrow("Unclassified CI check");
  expect(() =>
    classifiedChecks(
      fixture({ name: "New", env: { CI_CHECK_KIND: "STATIC" } }),
      "fixture",
    ),
  ).toThrow("no input closure");
  expect(() =>
    classifiedChecks(
      fixture({ name: "New", env: { CI_CHECK_KIND: "CONTEXTUAL" } }),
      "fixture",
    ),
  ).toThrow("no reason");
});

test("runtime classification failures warn with the task name before running checks fresh", () => {
  const fixture = {
    jobs: {
      fixture: { steps: [{ name: "New unclassified task", run: "true" }] },
    },
  };
  const operation = () => {
    classifiedChecks(fixture, "fixture");
  };
  expect(operation).toThrow(
    "Unclassified CI check: fixture/New unclassified task",
  );
  const warnings: string[] = [];
  runStaticReceiptBoundary(operation, (message) => warnings.push(message));
  expect(warnings).toEqual([
    "::warning::Static check receipts disabled; checks run fresh: Unclassified CI check: fixture/New unclassified task",
  ]);
  runStaticReceiptBoundary(
    () => {},
    (message) => warnings.push(message),
  );
  expect(warnings).toHaveLength(1);
});

test("input, resolved toolchain and task definition each invalidate the content key", () => {
  const base = {
    inputHash: "input",
    toolchain: { bun: "1.4.3", compiler: "7.0" },
    definition: { run: "bun check", env: { MODE: "check" } },
  };
  const key = staticCheckKey(base);
  expect(staticCheckKey(structuredClone(base))).toBe(key);
  for (const changed of [
    { ...base, inputHash: "changed input" },
    { ...base, toolchain: { ...base.toolchain, bun: "changed" } },
    { ...base, toolchain: { ...base.toolchain, compiler: "changed" } },
    { ...base, definition: { ...base.definition, run: "changed" } },
    { ...base, definition: { ...base.definition, env: { MODE: "changed" } } },
  ]) {
    expect(staticCheckKey(changed)).not.toBe(key);
  }
});

test("the shared generated input identity covers file bytes, inventory and executable mode", () => {
  const root = mkdtempSync(path.join(tmpdir(), "static-check-inputs-"));
  const git = (...args: string[]) => {
    const child = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(child.exitCode).toBe(0);
  };
  try {
    git("init", "--quiet");
    writeFileSync(path.join(root, "source.ts"), "first");
    writeFileSync(path.join(root, "bun.lock"), "resolved versions");
    git("add", ".");
    const key = generatedInputTreeHash({
      root,
      toolchain: "toolchain",
      generatedOutputs: "tracked",
      createHasher: createSha256,
      hashFile: sha256Hex,
      onFailure: expect.unreachable,
    });
    for (const filename of ["source.ts", "bun.lock"]) {
      const original = readFileSync(path.join(root, filename));
      writeFileSync(path.join(root, filename), "changed");
      expect(
        generatedInputTreeHash({
          root,
          toolchain: "toolchain",
          generatedOutputs: "tracked",
          createHasher: createSha256,
          hashFile: sha256Hex,
          onFailure: expect.unreachable,
        }),
      ).not.toBe(key);
      writeFileSync(path.join(root, filename), original);
    }
    expect(
      generatedInputTreeHash({
        root,
        toolchain: "toolchain",
        generatedOutputs: "tracked",
        createHasher: createSha256,
        hashFile: sha256Hex,
        onFailure: expect.unreachable,
      }),
    ).toBe(key);
    writeFileSync(path.join(root, "new-input.ts"), "new");
    git("add", "new-input.ts");
    expect(
      generatedInputTreeHash({
        root,
        toolchain: "toolchain",
        generatedOutputs: "tracked",
        createHasher: createSha256,
        hashFile: sha256Hex,
        onFailure: expect.unreachable,
      }),
    ).not.toBe(key);
    git("rm", "--cached", "new-input.ts");
    git("update-index", "--chmod=+x", "source.ts");
    expect(
      generatedInputTreeHash({
        root,
        toolchain: "toolchain",
        generatedOutputs: "tracked",
        createHasher: createSha256,
        hashFile: sha256Hex,
        onFailure: expect.unreachable,
      }),
    ).not.toBe(key);
    const output = "apps/web/src/routeTree.gen.ts";
    mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
    writeFileSync(path.join(root, output), "committed output");
    git("add", output);
    const before = generatedInputTreeHash({
      root,
      toolchain: "toolchain",
      generatedOutputs: "tracked",
      createHasher: createSha256,
      hashFile: sha256Hex,
      onFailure: expect.unreachable,
    });
    const producer = generatedInputTreeHash({
      root,
      toolchain: "toolchain",
      generatedOutputs: "exclude",
      createHasher: createSha256,
      hashFile: sha256Hex,
      onFailure: expect.unreachable,
    });
    writeFileSync(path.join(root, output), "hydrated output");
    expect(
      generatedInputTreeHash({
        root,
        toolchain: "toolchain",
        generatedOutputs: "tracked",
        createHasher: createSha256,
        hashFile: sha256Hex,
        onFailure: expect.unreachable,
      }),
    ).toBe(before);
    git("add", output);
    expect(
      generatedInputTreeHash({
        root,
        toolchain: "toolchain",
        generatedOutputs: "tracked",
        createHasher: createSha256,
        hashFile: sha256Hex,
        onFailure: expect.unreachable,
      }),
    ).not.toBe(before);
    expect(
      generatedInputTreeHash({
        root,
        toolchain: "toolchain",
        generatedOutputs: "exclude",
        createHasher: createSha256,
        hashFile: sha256Hex,
        onFailure: expect.unreachable,
      }),
    ).toBe(producer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const reuse = {
  event: "workflow_dispatch",
  ref: "refs/heads/main",
  kind: "STATIC",
  key: "key",
  runId: 42,
  receipt: { status: "passed", key: "key", runId: 42 },
};
test("identical green receipts reuse only static checks on main after the queue proof", () => {
  expect(reusableStaticReceipt(reuse)).toBe(true);
  for (const changed of [
    { ...reuse, kind: "CONTEXTUAL" },
    { ...reuse, event: "merge_group" },
    { ...reuse, event: "pull_request" },
    { ...reuse, ref: "refs/heads/feature" },
    { ...reuse, key: "other" },
    { ...reuse, runId: 43 },
    ...[
      undefined,
      null,
      "corrupt",
      {},
      { ...reuse.receipt, status: "failed" },
    ].map((receipt) => ({ ...reuse, receipt })),
  ]) {
    expect(reusableStaticReceipt(changed)).toBe(false);
  }
});

test("the receipt boundary runs missing, corrupt, unreadable and failed downloads fresh", () => {
  const options = {
    event: reuse.event,
    ref: reuse.ref,
    keys: { checked: "key", other: "other-key" },
    bundleKey: "bundle",
  };
  const source = {
    runId: 42,
    raw: { bundleKey: "bundle", tasks: { checked: reuse.receipt } },
  };
  expect(resolveStaticReuse({ ...options, download: () => source })).toEqual({
    status: "available",
    reused: [{ id: "checked", key: "key", runId: 42 }],
  });
  for (const download of [
    () => undefined,
    () => ({ ...source, raw: { bundleKey: "other", tasks: source.raw.tasks } }),
    () => ({ ...source, raw: { bundleKey: "bundle", tasks: null } }),
  ]) {
    expect(resolveStaticReuse({ ...options, download })).toEqual({
      status: "available",
      reused: [],
    });
  }
  const directory = mkdtempSync(path.join(tmpdir(), "static-check-receipt-"));
  try {
    const file = path.join(directory, "receipt.json");
    writeFileSync(file, "corrupt JSON");
    const corrupt = resolveStaticReuse({
      ...options,
      download: () => ({
        runId: 42,
        raw: JSON.parse(readFileSync(file, "utf-8")),
      }),
    });
    expect(corrupt.status).toBe("unavailable");
    rmSync(file);
    const missing = resolveStaticReuse({
      ...options,
      download: () => ({
        runId: 42,
        raw: JSON.parse(readFileSync(file, "utf-8")),
      }),
    });
    expect(missing.status).toBe("unavailable");
    expect(
      resolveStaticReuse({
        ...options,
        download: () => {
          throw new TypeError("transport unavailable");
        },
      }),
    ).toEqual({ status: "unavailable", message: "transport unavailable" });
    for (const event of ["merge_group", "pull_request"]) {
      let fetched = false;
      expect(
        resolveStaticReuse({
          ...options,
          event,
          download: () => {
            fetched = true;
            return source;
          },
        }),
      ).toEqual({ status: "available", reused: [] });
      expect(fetched).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("candidate downloads discard stale receipts and continue after missing or failed downloads", () => {
  const destination = mkdtempSync(
    path.join(tmpdir(), "static-check-download-"),
  );
  const file = path.join(destination, "receipt.json");
  const stale = { bundleKey: "bundle", tasks: { checked: reuse.receipt } };
  try {
    for (const failure of ["missing", "failed", "corrupt"]) {
      for (const candidates of [[42], [42, 43]]) {
        mkdirSync(destination, { recursive: true });
        writeFileSync(file, JSON.stringify(stale));
        const downloads: number[] = [];
        const resolved = resolveStaticReuse({
          event: reuse.event,
          ref: reuse.ref,
          keys: { checked: "key" },
          bundleKey: "bundle",
          download: () =>
            downloadReceipt({
              name: "receipt-artifact",
              destination,
              repository: "owner/repo",
              request: (...args) => {
                if (args[0] === "api") {
                  const endpoint = args.at(1) ?? "";
                  if (endpoint.includes("/artifacts?")) {
                    return JSON.stringify({
                      artifacts: candidates.map((id) => ({
                        name: "receipt-artifact",
                        expired: false,
                        size_in_bytes: 100,
                        workflow_run: { id },
                      })),
                    });
                  }
                  return JSON.stringify({
                    id: Number(endpoint.split("/").at(-1)),
                    event: "merge_group",
                    path: ".github/workflows/ci.yml",
                    status: "completed",
                    conclusion: "success",
                    repository: { id: 1, full_name: "owner/repo" },
                    head_repository: { id: 1 },
                  });
                }
                const runId = Number(args.at(2));
                downloads.push(runId);
                expect(existsSync(file)).toBe(false);
                if (runId === 42) {
                  if (failure === "failed") {
                    mkdirSync(destination, { recursive: true });
                    writeFileSync(file, JSON.stringify(stale));
                    throw new TypeError(
                      "download failed after a partial write",
                    );
                  }
                  if (failure === "corrupt") {
                    mkdirSync(destination, { recursive: true });
                    writeFileSync(file, "invalid JSON");
                  }
                  return "";
                }
                mkdirSync(destination, { recursive: true });
                writeFileSync(
                  file,
                  JSON.stringify({
                    bundleKey: "bundle",
                    tasks: { checked: { ...reuse.receipt, runId } },
                  }),
                );
                return "";
              },
            }),
        });
        expect(downloads).toEqual(candidates);
        expect(resolved).toEqual({
          status: "available",
          reused:
            candidates.length === 1
              ? []
              : [{ id: "checked", key: "key", runId: 43 }],
        });
      }
    }
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("receipts require a successful queue run in the same repository and workflow", () => {
  const run = {
    id: 42,
    event: "merge_group",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    repository: { id: 1, full_name: "owner/repo" },
    head_repository: { id: 1 },
  };
  expect(
    trustedQueueRun({ raw: run, repository: "owner/repo", runId: 42 }),
  ).toBe(true);
  for (const changed of [
    { ...run, event: "pull_request" },
    { ...run, id: 43 },
    { ...run, path: ".github/workflows/other.yml" },
    { ...run, status: "in_progress" },
    { ...run, conclusion: "failure" },
    { ...run, head_repository: { id: 2 } },
    { ...run, repository: { id: 1, full_name: "other/repo" } },
  ]) {
    expect(
      trustedQueueRun({ raw: changed, repository: "owner/repo", runId: 42 }),
    ).toBe(false);
  }
});

test("skipped, cancelled, failed and continue-on-error tasks publish no success receipt", () => {
  const keys = { checked: "key", other: "other-key" };
  expect(
    passedStaticChecks({
      keys,
      outcomes: { checked: { outcome: "success", conclusion: "success" } },
      runId: 42,
    }),
  ).toEqual({ checked: reuse.receipt });
  for (const outcome of ["skipped", "cancelled", "failure"]) {
    expect(
      passedStaticChecks({
        keys,
        outcomes: { checked: { outcome, conclusion: "success" } },
        runId: 42,
      }),
    ).toEqual({});
    expect(
      passedStaticChecks({
        keys,
        outcomes: { checked: { outcome: "success", conclusion: outcome } },
        runId: 42,
      }),
    ).toEqual({});
  }
});
