import { describe, expect, test } from "bun:test";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import type { SkillRunnerInput } from "@stll/api-contract/skill-runner";
import { ZipArchive } from "@stll/docx-core/zip";
import { sha256Hex } from "@stll/sha256/node";

import { runCommand } from "./command";
import { type ArchiveTransport, runSkillCommand } from "./run";

const BUN = process.execPath;

const zipOf = async (files: Record<string, string>) => {
  const archive = new ZipArchive();
  for (const [name, content] of Object.entries(files)) {
    archive.set(name, content);
  }
  return await archive.generate();
};

const filesOf = async (bytes: Uint8Array) => {
  const archive = await ZipArchive.read(bytes);
  const files: Record<string, string> = {};
  for (const entry of archive.entries()) {
    files[entry.path] = await entry.text();
  }
  return files;
};

/** Presigned URLs stood in by a map; puts land in it too. */
const memoryTransport = (
  objects: Map<string, Uint8Array>,
): ArchiveTransport => ({
  get: async (url, maxBytes) => {
    const bytes = objects.get(url);
    if (bytes === undefined || bytes.byteLength > maxBytes) {
      throw new Error(`no object at ${url}`);
    }
    return bytes;
  },
  put: async (url, bytes) => {
    objects.set(url, bytes);
  },
});

const setup = async (
  argv: string[],
  {
    workspace = { "case.json": '{"flight":"WFL8751"}' },
    egressProxyUrl = null,
  }: {
    workspace?: Record<string, string> | null;
    egressProxyUrl?: string | null;
  } = {},
) => {
  const skill = await zipOf({
    "SKILL.md": "---\nname: facts\ndescription: Test.\n---\n",
    "scripts/hello.ts": 'console.log("from the skill");',
  });
  const objects = new Map<string, Uint8Array>([
    ["https://s3.test/skill.zip", skill],
  ]);
  if (workspace !== null) {
    objects.set("https://s3.test/workspace-in.zip", await zipOf(workspace));
  }
  const input: SkillRunnerInput = {
    runId: "0192f3a0-6b1c-7d2e-8f30-0000000000f0",
    command: { argv, cwd: ".", timeoutMs: 20_000 },
    workspaceGetUrl:
      workspace === null ? null : "https://s3.test/workspace-in.zip",
    workspacePutUrl: "https://s3.test/workspace-out.zip",
    skill: {
      name: "facts",
      getUrl: "https://s3.test/skill.zip",
      sha256: sha256Hex(skill),
    },
    egressProxyUrl,
  };
  return { input, objects, transport: memoryTransport(objects) };
};

describe("one skill command", () => {
  test("runs against the workspace, keeps what it wrote and reports the change", async () => {
    const { input, objects, transport } = await setup([
      BUN,
      "-e",
      'const fs = require("node:fs"); fs.mkdirSync("out"); fs.writeFileSync("out/memo.md", "# Memo\\n" + fs.readFileSync("case.json", "utf8"));',
    ]);
    const result = (
      await runSkillCommand(input, transport, {
        environment: { PATH: process.env["PATH"] },
      })
    ).unwrap();
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.changedFiles.map(({ path: file }) => file)).toEqual([
      "out/memo.md",
    ]);
    expect(result.removedFiles).toEqual([]);
    const stored = await filesOf(
      objects.get("https://s3.test/workspace-out.zip")!,
    );
    expect(stored).toEqual({
      "case.json": '{"flight":"WFL8751"}',
      "out/memo.md": '# Memo\n{"flight":"WFL8751"}',
    });
  });

  test("the skill's own files are readable and never stored with the workspace", async () => {
    const { input, objects, transport } = await setup(
      // The skill sits beside the workspace, outside it.
      [BUN, "../skills/facts/scripts/hello.ts"],
      { workspace: null },
    );
    const result = (
      await runSkillCommand(input, transport, {
        environment: { PATH: process.env["PATH"] },
      })
    ).unwrap();
    expect(result.stdout.text).toBe("from the skill\n");
    expect(
      await filesOf(objects.get("https://s3.test/workspace-out.zip")!),
    ).toEqual({});
  });

  test("a command sees only its allowlisted environment, never the Lambda's credentials", async () => {
    const { input, transport } = await setup([
      BUN,
      "-e",
      "console.log(JSON.stringify(process.env))",
    ]);
    const result = (
      await runSkillCommand(input, transport, {
        environment: {
          PATH: process.env["PATH"],
          AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
          AWS_SECRET_ACCESS_KEY: "secret",
          AWS_SESSION_TOKEN: "token",
          AWS_LAMBDA_RUNTIME_API: "127.0.0.1:9001",
        },
      })
    ).unwrap();
    const seen = v.parse(
      v.record(v.string(), v.string()),
      JSON.parse(result.stdout.text),
    );
    expect(Object.keys(seen).filter((key) => key.startsWith("AWS_"))).toEqual(
      [],
    );
    expect(seen["HTTPS_PROXY"]).toBeUndefined();
    expect(seen["XDG_CACHE_HOME"]).toMatch(/skill-run-[^/]+\/cache$/u);
    expect(seen["SKILL_DIR"]).toMatch(/skill-run-[^/]+\/skills\/facts$/u);
  });

  test("the egress proxy, when given, is the HTTP clients' only route", async () => {
    const proxy = "http://run-token@proxy.internal:4750";
    const { input, transport } = await setup(
      [
        BUN,
        "-e",
        "console.log(process.env.HTTPS_PROXY + ' ' + process.env.http_proxy)",
      ],
      { egressProxyUrl: proxy },
    );
    const result = (
      await runSkillCommand(input, transport, {
        environment: { PATH: process.env["PATH"] },
      })
    ).unwrap();
    expect(result.stdout.text).toBe(`${proxy} ${proxy}\n`);
  });

  test("a removed file is reported and left out of the stored workspace", async () => {
    const { input, objects, transport } = await setup([
      BUN,
      "-e",
      'require("node:fs").rmSync("case.json")',
    ]);
    const result = (
      await runSkillCommand(input, transport, {
        environment: { PATH: process.env["PATH"] },
      })
    ).unwrap();
    expect(result.removedFiles).toEqual(["case.json"]);
    expect(
      await filesOf(objects.get("https://s3.test/workspace-out.zip")!),
    ).toEqual({});
  });

  test("a skill archive that does not match its digest runs nothing", async () => {
    const { input, objects, transport } = await setup([BUN, "-e", "1"]);
    const refused = await runSkillCommand(
      { ...input, skill: { ...input.skill, sha256: "0".repeat(64) } },
      transport,
      { environment: { PATH: process.env["PATH"] } },
    );
    expect(refused.isErr() && refused.error.message).toBe(
      "Skill archive does not match its digest",
    );
    expect(objects.has("https://s3.test/workspace-out.zip")).toBe(false);
  });

  test("a program that does not exist is reported as not started", async () => {
    const { input, transport } = await setup(["definitely-not-a-program-here"]);
    const result = (
      await runSkillCommand(input, transport, {
        environment: { PATH: "/nonexistent" },
      })
    ).unwrap();
    expect(result.outcome).toBe("not_started");
    expect(result.exitCode).toBeNull();
  });
});

describe("the command process", () => {
  // A grandchild left running would hold the output pipes open, so the
  // command would not settle before the test's own timeout.
  test("a timeout ends the command and everything it started", async () => {
    const outcome = await runCommand({
      argv: [BUN, "-e", 'Bun.spawn(["sleep", "30"]); await Bun.sleep(30_000);'],
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 1000,
    });
    expect(outcome.outcome).toBe("timed_out");
  });

  // The descendant holds the write end of a FIFO and none of the command's
  // pipes; the test's read end sees EOF only once it is dead. Left running,
  // it would hold the FIFO open past the test's own timeout.
  test("nothing the command started outlives its exit", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "descendant-"));
    const fifo = path.join(folder, "held");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const reader = createReadStream(fifo);
    const released = new Promise<void>((resolve) => {
      reader.on("end", resolve);
    });
    reader.resume();
    const outcome = await runCommand({
      argv: [
        BUN,
        "-e",
        // Exits only once the descendant holds the FIFO.
        'const held = Bun.spawn(["sh", "-c", "exec 3>\\"$0\\"; echo held; exec sleep 30", process.argv.at(-1)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }); await held.stdout.getReader().read(); process.exit(0);',
        fifo,
      ],
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 20_000,
    });
    expect(outcome.outcome).toBe("exited");
    await released;
    await rm(folder, { recursive: true, force: true });
  });

  test("output beyond the cap is dropped and counted", async () => {
    const outcome = await runCommand({
      argv: [BUN, "-e", 'process.stdout.write("x".repeat(5000))'],
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutMs: 20_000,
      streamBytes: 1000,
    });
    expect(outcome.stdout.text).toBe("x".repeat(1000));
    expect(outcome.stdout.droppedBytes).toBe(4000);
  });
});
