import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  CACHE_SAVE_WORKER_FILE,
  createSaveProgress,
  runCacheSave,
} from "./ci-store-save";

const node = Bun.which("node");
if (node === null) {
  throw new TypeError("Cache supervisor tests require the Node action runtime");
}
const launcher = path.resolve(
  import.meta.dir,
  "../.github/actions/ci-store-save/index.mjs",
);

test("the action has one main phase and no post-job save", () => {
  const action = v.parse(
    v.object({ runs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(
      readFileSync(
        path.resolve(
          import.meta.dir,
          "../.github/actions/ci-store-save/action.yml",
        ),
        "utf-8",
      ),
    ),
  );
  expect(action.runs["main"]).toBe("index.mjs");
  expect(action.runs).not.toHaveProperty("post");
  expect(action.runs).not.toHaveProperty("post-if");
});

test("the native Node entry saves immediately and converts preparation failures into warning telemetry", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cache-save-action-"));
  try {
    const summary = path.join(directory, "summary");
    const failed = Bun.spawnSync([node, launcher], {
      env: {
        PATH: directory,
        INPUT_KEY: "fixture",
        INPUT_PATH: directory,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    const log = new TextDecoder().decode(failed.stdout);
    expect(failed.exitCode).toBe(0);
    expect(log).toContain("::warning title=install-store-save::");
    expect(log).toContain("refusing a gzip cache save");
    expect(log).toContain('"outcome":"failed"');
    expect(readFileSync(summary, "utf-8")).toContain('"saveMs":');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing main-phase inputs warn without failing the action", () => {
  const result = Bun.spawnSync([node, launcher], { env: {} });
  const log = new TextDecoder().decode(result.stdout);
  expect(result.exitCode).toBe(0);
  expect(log).toContain("Missing cache action inputs");
  expect(log).toContain('"outcome":"failed"');
});

const runFixture = async (source: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "cache-save-test-"));
  const inheritedTemp = mkdtempSync(path.join(tmpdir(), "cache-save-parent-"));
  const entry = path.join(directory, "worker.cjs");
  writeFileSync(entry, source);
  try {
    return await runCacheSave({
      entry,
      directory,
      env: {
        ...process.env,
        TMPDIR: inheritedTemp,
        TEMP: inheritedTemp,
        TMP: inheritedTemp,
      },
      progress: createSaveProgress(Date.now()),
      executable: node,
      stallMs: 1000,
      pollMs: 25,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(inheritedTemp, { recursive: true, force: true });
  }
};

test("the downloaded cache worker runs as an ES module without a package.json", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cache-save-esm-"));
  const entry = path.join(directory, CACHE_SAVE_WORKER_FILE);
  writeFileSync(
    entry,
    `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    require('node:fs').writeFileSync('esm-executed', 'yes');
    console.log('Cache saved with key: fixture');
  `,
  );
  try {
    expect(
      await runCacheSave({
        entry,
        directory,
        env: process.env,
        progress: createSaveProgress(Date.now()),
        executable: node,
        stallMs: 1000,
        pollMs: 25,
      }),
    ).toBe("saved");
    expect(readFileSync(path.join(directory, "esm-executed"), "utf-8")).toBe(
      "yes",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only increasing byte counters reset stall time, independently of total duration", () => {
  const progress = createSaveProgress(0);
  for (let time = 500; time <= 600_000; time += 500) {
    progress.advance({ phase: "archive", bytes: time, time });
    expect(progress.stalled(time + 999, 1000)).toBe(false);
  }
  progress.advance({ phase: "archive", bytes: 600_000, time: 600_500 });
  progress.advance({ phase: "archive", bytes: 0, time: 600_750 });
  expect(progress.stalled(601_000, 1000)).toBe(true);
  progress.advance({ phase: "upload", bytes: 1, time: 601_100 });
  expect(progress.stalled(602_099, 1000)).toBe(false);
  expect(progress.stalled(602_100, 1000)).toBe(true);
});

test.each(["cache.tzst", "cache.tar"])(
  "%s growth under os.tmpdir keeps silent compression alive beyond the stall interval",
  async (filename) => {
    expect(
      await runFixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'archive-'));
    const archive = path.join(directory, ${JSON.stringify(filename)});
    let ticks = 0;
    const timer = setInterval(() => {
      fs.appendFileSync(archive, 'payload');
      if (++ticks === 8) {
        clearInterval(timer);
        console.log('Cache saved with key: fixture');
      }
    }, 200);
  `),
    ).toBe("saved");
  },
);

test.each(["cache.tzst", "cache.tar"])(
  "%s under os.tmpdir is stopped when archive growth stalls",
  async (filename) => {
    expect(
      await runFixture(`
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'archive-'));
    fs.writeFileSync(path.join(directory, ${JSON.stringify(filename)}), 'payload');
    setInterval(() => {}, 200);
  `),
    ).toBe("stalled");
  },
);

test("upload bytes reset the watchdog even when progress lines arrive in separate chunks", async () => {
  expect(
    await runFixture(`
    let ticks = 0;
    const timer = setInterval(() => {
      process.stdout.write('Sent ');
      setTimeout(() => {
        process.stdout.write(String(++ticks) + ' of 8\\n');
        if (ticks === 8) {
          clearInterval(timer);
          console.log('Cache saved with key: fixture');
        }
      }, 20);
    }, 150);
  `),
  ).toBe("saved");
});

test("a stalled fake save is killed at the watchdog bound without failing", async () => {
  expect(
    await runFixture(
      `setInterval(() => console.log('Sent 0 of 100 (0%)'), 100)`,
    ),
  ).toBe("stalled");
});

test("cache-tool failures and warning-only exits remain distinct from a committed save", async () => {
  expect(await runFixture("process.exit(1)")).toBe("failed");
  expect(
    await runFixture("console.log('::warning::Cache service unavailable')"),
  ).toBe("warning");
});

test("a stalled Unix save kills its compressor descendants too", async () => {
  if (process.platform === "win32") {
    return;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "cache-save-tree-"));
  const entry = path.join(directory, "worker.cjs");
  writeFileSync(
    entry,
    `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    require('node:fs').writeFileSync('compressor-pid', String(child.pid));
    setInterval(() => {}, 1000);
  `,
  );
  try {
    expect(
      await runCacheSave({
        entry,
        directory,
        env: process.env,
        progress: createSaveProgress(Date.now()),
        executable: node,
        stallMs: 1000,
        pollMs: 25,
      }),
    ).toBe("stalled");
    const pid = Number(
      readFileSync(path.join(directory, "compressor-pid"), "utf-8"),
    );
    // A killed child can remain a zombie until its parent is reaped. It cannot
    // continue CPU work or retain the cache upload/compression pipeline.
    const status = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    expect(new TextDecoder().decode(status.stdout).trim()).toMatch(/^Z|^$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
