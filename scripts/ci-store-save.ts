import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex } from "../packages/sha256/src/node.ts";

// Node's action runtime must work without any workspace dependencies. Execute
// the same pinned implementation as restore without private runner-path assumptions.
export const CACHE_SAVE_REVISION = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
export const CACHE_SAVE_SHA256 =
  "0d3cf341a79cdc0a8ce5a71103f46174e12cf4f98db46f15b8e604932eefd487";
export const CACHE_SAVE_WORKER_FILE = "upstream-save.mjs";
const STALL_MS = 120_000;
const BUDGET_MS = 60_000;
const activeChildren = new Set<ChildProcess>();

class StoreSaveError extends Error {
  override name = "StoreSaveError";
  readonly _tag = "StoreSaveError";
}

const warning = (message: string) =>
  console.log(
    `::warning title=install-store-save::${message.replaceAll("%", "%25").replaceAll("\n", "%0A").replaceAll("\r", "%0D")}`,
  );

type SaveProgressOptions = { phase: string; bytes: number; time: number };

export const createSaveProgress = (now: number) => {
  let lastProgress = now;
  const counters = new Map<string, number>();
  return {
    advance: ({ phase, bytes, time }: SaveProgressOptions) => {
      if (bytes <= (counters.get(phase) ?? 0)) {
        return;
      }
      counters.set(phase, bytes);
      lastProgress = time;
    },
    stalled: (time: number, stallMs: number) => time - lastProgress >= stallMs,
  };
};

const killTree = (child: ChildProcess) => {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    killer.on("error", (error) => {
      warning(`Cache save process-tree cleanup failed: ${error.message}`);
      child.kill("SIGKILL");
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ESRCH"
    ) {
      warning(`Cache save process-tree cleanup failed: ${String(error)}`);
    }
  }
};

type RunCacheSaveOptions = {
  entry: string;
  directory: string;
  env: NodeJS.ProcessEnv;
  progress: ReturnType<typeof createSaveProgress>;
  executable?: string;
  stallMs?: number;
  pollMs?: number;
};
export const runCacheSave = async ({
  entry,
  directory,
  env,
  progress,
  executable = process.execPath,
  stallMs = STALL_MS,
  pollMs = 1000,
}: RunCacheSaveOptions) =>
  new Promise<"saved" | "stalled" | "failed" | "warning">((resolve, reject) => {
    let tail = "";
    let outcome: "saved" | "warning" = "warning";
    let stalled = false;
    const child = spawn(executable, [entry], {
      cwd: directory,
      // The upstream cache tool places its archive in one UUID subdirectory.
      // Bind every os.tmpdir() override to the monitored root on Unix and Windows.
      // Owning that temp root bounds monitoring to a few files, not the store.
      env: {
        ...env,
        RUNNER_TEMP: directory,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const output = (chunk: Buffer) => {
      process.stdout.write(chunk);
      tail = (tail + chunk.toString()).slice(-4096);
      for (const match of tail.matchAll(/Sent (\d+) of/gu)) {
        progress.advance({
          phase: "upload",
          bytes: Number(match[1]),
          time: Date.now(),
        });
      }
      if (tail.includes("Cache saved with key:")) {
        outcome = "saved";
      }
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    const timer = setInterval(() => {
      try {
        for (const folder of readdirSync(directory, { withFileTypes: true })) {
          if (!folder.isDirectory()) {
            continue;
          }
          for (const filename of ["cache.tzst", "cache.tar"]) {
            const archive = path.join(directory, folder.name, filename);
            const stat = statSync(archive, { throwIfNoEntry: false });
            if (stat !== undefined) {
              progress.advance({
                phase: archive,
                bytes: stat.size,
                time: Date.now(),
              });
            }
          }
        }
        if (!progress.stalled(Date.now(), stallMs) || stalled) {
          return;
        }
        stalled = true;
        warning(
          `No archive or upload progress for ${stallMs}ms; stopping cache save.`,
        );
        killTree(child);
      } catch (error) {
        clearInterval(timer);
        killTree(child);
        reject(
          error instanceof Error
            ? error
            : new StoreSaveError("Cache save monitoring failed", {
                cause: error,
              }),
        );
      }
    }, pollMs);
    child.on("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(timer);
      activeChildren.delete(child);
      if (stalled) {
        resolve("stalled");
        return;
      }
      if (code !== 0) {
        resolve("failed");
        return;
      }
      resolve(outcome);
    });
  });

type SaveStoreOptions = { key: string; store: string };
const saveStore = async ({ key, store }: SaveStoreOptions) => {
  const start = Date.now();
  const progress = createSaveProgress(start);
  const controller = new AbortController();
  let directory;
  let outcome = "failed";
  let warned = false;
  const budgetTimer = setInterval(() => {
    if (!warned && Date.now() - start >= BUDGET_MS) {
      warned = true;
      warning(
        `Cache save exceeded its ${BUDGET_MS}ms budget; continuing while progress advances.`,
      );
    }
  }, 1000);
  const downloadTimer = setInterval(() => {
    if (progress.stalled(Date.now(), STALL_MS)) {
      controller.abort();
    }
  }, 1000);
  try {
    if (spawnSync("zstd", ["--version"], { stdio: "ignore" }).status !== 0) {
      throw new StoreSaveError("zstd unavailable; refusing a gzip cache save");
    }
    directory = mkdtempSync(path.join(tmpdir(), "stella-store-save-"));
    const response = await fetch(
      `https://raw.githubusercontent.com/actions/cache/${CACHE_SAVE_REVISION}/dist/save-only/index.js`,
      { signal: controller.signal },
    );
    if (!response.ok || response.body === null) {
      throw new StoreSaveError(
        `Cache action download failed: HTTP ${response.status}`,
      );
    }
    const chunks = [];
    let downloaded = 0;
    for await (const chunk of response.body) {
      chunks.push(chunk);
      downloaded += chunk.length;
      progress.advance({
        phase: "download",
        bytes: downloaded,
        time: Date.now(),
      });
    }
    const source = Buffer.concat(chunks);
    clearInterval(downloadTimer);
    if (sha256Hex(source) !== CACHE_SAVE_SHA256) {
      throw new StoreSaveError("Cache action integrity check failed");
    }
    const entry = path.join(directory, CACHE_SAVE_WORKER_FILE);
    writeFileSync(entry, source);
    outcome = await runCacheSave({
      entry,
      directory,
      progress,
      env: {
        ...process.env,
        INPUT_KEY: key,
        INPUT_PATH: store,
        INPUT_ENABLECROSSOSARCHIVE: "false",
      },
    });
    if (outcome !== "saved") {
      warning(`Cache save outcome: ${outcome}; job work is unaffected.`);
    }
  } catch (error) {
    warning(
      `Cache save failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearInterval(budgetTimer);
    clearInterval(downloadTimer);
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
    const telemetry = JSON.stringify({
      event: "install-store-save",
      key,
      compression: "zstd",
      outcome,
      saveMs: Date.now() - start,
    });
    console.log(telemetry);
    if (process.env["GITHUB_STEP_SUMMARY"]) {
      appendFileSync(
        process.env["GITHUB_STEP_SUMMARY"],
        `\n\`\`\`json\n${telemetry}\n\`\`\`\n`,
      );
    }
  }
};

export const runStoreSaveAction = async () => {
  // The post hook is a boundary: failed cache maintenance must warn without
  // changing the job verdict, even when cleanup or telemetry writing fails.
  const fatal = (error: unknown) => {
    for (const child of activeChildren) {
      killTree(child);
    }
    warning(
      `Cache maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      JSON.stringify({ event: "install-store-save", outcome: "failed" }),
    );
    process.exit(0);
  };
  process.once("uncaughtException", fatal);
  process.once("unhandledRejection", fatal);
  try {
    const key = process.env["STATE_key"];
    const store = process.env["STATE_store"];
    if (key !== undefined && store !== undefined) {
      await saveStore({ key, store });
      return;
    }
    const state = process.env["GITHUB_STATE"];
    const inputKey = process.env["INPUT_KEY"];
    const inputStore = process.env["INPUT_PATH"];
    if (
      state === undefined ||
      inputKey === undefined ||
      inputStore === undefined
    ) {
      throw new StoreSaveError("Missing cache action state or inputs");
    }
    appendFileSync(state, `key=${inputKey}\nstore=${inputStore}\n`);
  } catch (error) {
    warning(
      `Cache maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      JSON.stringify({ event: "install-store-save", outcome: "failed" }),
    );
  }
};
