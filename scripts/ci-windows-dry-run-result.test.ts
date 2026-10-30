import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { reusableResultRun } from "../packages/scripts/src/prepared-generated-sources";
import {
  findWindowsResult,
  windowsResultKey,
} from "./ci-windows-dry-run-result";
import { evaluate } from "./github-expression";

const tools = {
  bun: "1",
  rust: "1",
  cargo: "1",
  node: "1",
  tauri: "1",
  image: "1",
  os: "1",
  visualStudio: "1",
  sdk: "1",
  msvc: "1",
};

test("every tracked source, generated output and recipe affects the Windows proof key", () => {
  const root = mkdtempSync(path.join(tmpdir(), "windows-proof-"));
  const files = [
    "apps/desktop/src/view.tsx",
    "packages/ui/src/view.tsx",
    "apps/web/src/routeTree.gen.ts",
    ".github/workflows/ci.yml",
    ".github/actions/desktop-windows-build/action.yml",
  ];
  try {
    for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "original");
    }
    for (const args of [
      ["init", "-q"],
      ["add", "."],
    ]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: root }).exitCode).toBe(0);
    }
    const options = {
      root,
      tools,
      profile: "dry-run;nsis",
      workflow: "executed recipe",
    };
    const key = windowsResultKey(options);
    expect(windowsResultKey(options)).toBe(key);
    expect(
      windowsResultKey({
        ...options,
        tools: Object.fromEntries(Object.entries(tools).toReversed()),
      }),
    ).toBe(key);
    for (const file of files) {
      writeFileSync(path.join(root, file), "changed");
      expect(windowsResultKey(options)).not.toBe(key);
      writeFileSync(path.join(root, file), "original");
    }
    for (const tool of Object.keys(options.tools)) {
      expect(
        windowsResultKey({
          ...options,
          tools: { ...options.tools, [tool]: "changed" },
        }),
      ).not.toBe(key);
    }
    expect(
      windowsResultKey({ ...options, workflow: "new executed recipe" }),
    ).not.toBe(key);
    expect(windowsResultKey({ ...options, profile: "release;nsis" })).not.toBe(
      key,
    );
    expect(() => windowsResultKey({ ...options, tools: {} })).toThrow(
      "Incomplete Windows build identity",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const key = "a".repeat(64);
const receipt = {
  inputHash: key,
  runId: "123",
  event: "merge_group",
  conclusion: "success",
};

test("identical queue and main trees reuse across distinct commits while changed source misses", () => {
  const root = mkdtempSync(path.join(tmpdir(), "windows-tree-proof-"));
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const commit = (message: string) =>
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      message,
    ]);
  try {
    git(["init", "-q"]);
    writeFileSync(path.join(root, "input.ts"), "original");
    git(["add", "input.ts"]);
    commit("queue");
    const queueSha = git(["rev-parse", "HEAD"]);
    const queueTree = git(["rev-parse", "HEAD^{tree}"]);
    const options = {
      root,
      tools,
      profile: "dry-run;nsis",
      workflow: "executed recipe",
    };
    const queueKey = windowsResultKey(options);
    const queueReceipt = { ...receipt, inputHash: queueKey };
    commit("main");
    expect(git(["rev-parse", "HEAD"])).not.toBe(queueSha);
    expect(git(["rev-parse", "HEAD^{tree}"])).toBe(queueTree);
    const mainKey = windowsResultKey(options);
    expect(mainKey).toBe(queueKey);
    expect(reusableResultRun(queueReceipt, mainKey, "push")).toBe("123");
    writeFileSync(path.join(root, "input.ts"), "changed");
    git(["add", "input.ts"]);
    commit("changed source");
    expect(git(["rev-parse", "HEAD^{tree}"])).not.toBe(queueTree);
    expect(windowsResultKey(options)).not.toBe(queueKey);
    expect(
      reusableResultRun(queueReceipt, windowsResultKey(options), "push"),
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "the executable boundary runs fully on unreadable keys or receipts and records valid reuse",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "windows-result-boundary-"));
    try {
      expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(
        0,
      );
      writeFileSync(path.join(root, "input.ts"), "input");
      expect(
        Bun.spawnSync(["git", "add", "input.ts"], { cwd: root }).exitCode,
      ).toBe(0);
      expect(
        Bun.spawnSync(
          [
            "git",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "fixture",
          ],
          { cwd: root },
        ).exitCode,
      ).toBe(0);
      const bin = path.join(root, "bin");
      mkdirSync(bin);
      const gh = path.join(bin, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = readFileSync(${JSON.stringify(path.join(root, "proof-mode"))}, "utf-8");
if (mode === "api-failure") process.exit(1);
if (args[1]?.includes("/contents/")) { console.log(JSON.stringify({ content: Buffer.from("executed recipe").toBase64(), encoding: "base64" })); process.exit(0); }
if (args[0] === "run") {
  const dir = args[args.indexOf("--dir") + 1];
  const name = args[args.indexOf("--name") + 1];
  if (mode !== "missing") writeFileSync(dir + "/manifest.json", mode === "corrupt" ? "{" : JSON.stringify({ inputHash: name.slice("desktop-windows-dry-run-".length), runId: "123", event: "merge_group", conclusion: "success" }));
} else if (args[1].includes("/artifacts?")) {
  const name = args[1].split("?name=")[1].split("&")[0];
  console.log(JSON.stringify({ artifacts: [{ name, expired: false, workflow_run: { id: 123 } }] }));
} else {
  console.log(JSON.stringify({ id: 123, event: "merge_group", conclusion: "success", path: ".github/workflows/ci.yml" }));
}
`,
      );
      chmodSync(gh, 0o755);
      let queueOutput = "";
      for (const mode of [
        "key-missing",
        "missing",
        "corrupt",
        "api-failure",
        "valid",
        "valid-main",
      ]) {
        writeFileSync(path.join(root, "proof-mode"), mode);
        const temporary = path.join(root, mode);
        mkdirSync(temporary);
        if (mode !== "key-missing") {
          writeFileSync(
            path.join(temporary, "windows-tools.json"),
            JSON.stringify(tools),
          );
        }
        const output = path.join(temporary, "output");
        const summary = path.join(temporary, "summary");
        writeFileSync(output, "");
        const result = Bun.spawnSync(
          [
            process.execPath,
            new URL("ci-windows-dry-run-result.ts", import.meta.url).pathname,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${String(process.env["PATH"])}`,
              RUNNER_TEMP: temporary,
              GITHUB_SHA: (mode === "valid-main" ? "b" : "a").repeat(40),
              WINDOWS_WORKFLOW_SHA: "b".repeat(40),
              GITHUB_EVENT_NAME: "schedule",
              GITHUB_REPOSITORY: "stella/stella",
              GITHUB_RUN_ID: "456",
              GITHUB_OUTPUT: output,
              GH_RETRY_SCRIPT: path.resolve(import.meta.dir, "gh-retry.sh"),
              GITHUB_STEP_SUMMARY: summary,
              WINDOWS_BUILD_PROFILE: "dry-run;nsis",
            },
          },
        );
        expect(result.exitCode).toBe(0);
        if (mode === "valid" || mode === "valid-main") {
          const currentOutput = readFileSync(output, "utf-8");
          if (mode === "valid") {
            queueOutput = currentOutput;
          } else {
            expect(currentOutput).toBe(queueOutput);
          }
          expect(readFileSync(output, "utf-8")).toContain("reused=true");
          expect(readFileSync(summary, "utf-8")).toMatch(
            /^reused [a-f0-9]{64} from run 123\n$/u,
          );
        } else {
          expect(readFileSync(output, "utf-8")).not.toContain("reused=true");
          expect(result.stdout.toString()).toContain("running full build");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("only an identical, complete green receipt reuses a result", () => {
  expect(reusableResultRun(receipt, key, "schedule")).toBe("123");
  for (const raw of [
    undefined,
    null,
    {},
    "corrupt",
    { ...receipt, inputHash: "b".repeat(64) },
    { ...receipt, event: "push" },
    { ...receipt, conclusion: "failure" },
    { ...receipt, runId: "" },
  ]) {
    expect(reusableResultRun(raw, key, "schedule")).toBeUndefined();
  }
  expect(reusableResultRun(receipt, key, "merge_group")).toBeUndefined();
});

test("reuse requires successful merge-group provenance and a matching downloaded manifest", () => {
  const name = `desktop-windows-dry-run-${key}`;
  const proof = {
    id: 123,
    event: "merge_group",
    conclusion: "success",
    path: ".github/workflows/ci.yml",
  };
  const lookup = (runProof: typeof proof, raw: unknown) => {
    let downloads = 0;
    const reused = findWindowsResult({
      key,
      event: "schedule",
      repository: "stella/stella",
      destination: "/tmp/receipt",
      run: (args) => {
        if (args.at(0) === "run") {
          downloads++;
          return "";
        }
        if (args.at(1)?.includes("/artifacts?")) {
          return JSON.stringify({
            artifacts: [{ name, expired: false, workflow_run: { id: 123 } }],
          });
        }
        return JSON.stringify(runProof);
      },
      readManifest: () => raw,
    });
    return { reused, downloads };
  };
  expect(lookup(proof, receipt)).toEqual({ reused: "123", downloads: 1 });
  for (const changed of [
    { ...proof, event: "push" },
    { ...proof, conclusion: "failure" },
    { ...proof, path: ".github/workflows/other.yml" },
    { ...proof, id: 124 },
  ]) {
    expect(lookup(changed, receipt)).toEqual({
      reused: undefined,
      downloads: 0,
    });
  }
  for (const raw of [undefined, {}, "corrupt", { ...receipt, runId: "124" }]) {
    expect(lookup(proof, raw).reused).toBeUndefined();
  }
  expect(
    findWindowsResult({
      key,
      event: "schedule",
      repository: "stella/stella",
      destination: "/tmp/receipt",
      run: () => JSON.stringify({ artifacts: [] }),
      readManifest: () => receipt,
    }),
  ).toBeUndefined();
});

test("merge-group and armed PR proofs always build; merge groups never look up receipts", () => {
  expect(
    findWindowsResult({
      key,
      event: "merge_group",
      repository: "stella/stella",
      destination: "/tmp/receipt",
      run: () => {
        throw new Error("Merge-group lookup must not run");
      },
      readManifest: () => receipt,
    }),
  ).toBeUndefined();
  const stepSchema = v.looseObject({
    name: v.string(),
    if: v.optional(v.string()),
    uses: v.optional(v.string()),
    run: v.optional(v.string()),
    with: v.optional(v.record(v.string(), v.unknown())),
  });
  const { jobs } = v.parse(
    v.object({
      jobs: v.record(
        v.string(),
        v.looseObject({ steps: v.optional(v.array(stepSchema)) }),
      ),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/ci.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  const steps = jobs["desktop-windows-dry-run"]?.steps ?? [];
  for (const name of [
    "Stamp dry-run metadata",
    "Fetch Rust dependencies",
    "Exercise Windows desktop release build",
  ]) {
    const condition = steps.find((step) => step.name === name)?.if;
    if (condition === undefined) {
      throw new TypeError(`Missing Windows build condition: ${name}`);
    }
    for (const event of [
      "merge_group",
      "pull_request",
      "push",
      "workflow_dispatch",
    ]) {
      for (const reused of ["true", "false", ""]) {
        expect(
          evaluate(condition, {
            values: {
              "github.event_name": event,
              "steps.receipt.outputs.reused": reused,
            },
          }),
          `${name}: ${event}, reused=${reused}`,
        ).toBe(
          event === "merge_group" ||
            event === "pull_request" ||
            reused !== "true",
        );
      }
    }
  }
  expect(
    steps.find((step) => step.name === "Exercise Windows desktop release build")
      ?.with?.["release-sha"],
  ).toBe("0".repeat(40));
  const upload = steps.find(
    (step) => step.name === "Upload successful queue dry-run receipt",
  );
  expect(upload?.if).toContain(
    "success() && github.event_name == 'merge_group'",
  );
  expect(upload?.with?.["name"]).toBe(
    `desktop-windows-dry-run-\${{ steps.receipt.outputs.key }}`,
  );
});
