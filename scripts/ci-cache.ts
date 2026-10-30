import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CACHE_REVISION = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";

const INFRA_ERROR =
  /(?:rate limit|HTTP 429|cache service (?:unavailable|failed)|GetCacheEntryDownloadURL|ECONNRESET|ETIMEDOUT|socket hang up|no archive or (?:upload|download) progress)/iu;

export type CacheOperation = "restore" | "save";

type RunCacheWorkerOptions = {
  operation: CacheOperation;
  entry: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  stallMs?: number;
};

const annotation = (operation: CacheOperation, detail: string) =>
  `::warning title=cache-${operation}-skipped::kind=infra class=cache-${operation} outcome=skipped ${detail}`;

export const runCacheWorker = async ({
  operation,
  entry,
  env = process.env,
  executable = process.execPath,
  stallMs = 120_000,
}: RunCacheWorkerOptions) =>
  new Promise<number>((resolve, reject) => {
    let output = "";
    let lastProgress = Date.now();
    let stopped = false;
    const child: ChildProcess = spawn(executable, [entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const consume = (chunk: Buffer) => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-16_384);
      lastProgress = Date.now();
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const timer = setInterval(
      () => {
        if (Date.now() - lastProgress < stallMs) {
          return;
        }
        stopped = true;
        child.kill("SIGKILL");
      },
      Math.min(1000, stallMs),
    );
    child.once("error", reject);
    child.once("close", (code) => {
      clearInterval(timer);
      if (code === 0) {
        return resolve(0);
      }
      const infra = stopped || INFRA_ERROR.test(output);
      if (operation === "save" || infra) {
        const reason = stopped
          ? `reason=stalled idle_ms=${stallMs}`
          : "reason=service-error";
        console.log(annotation(operation, reason));
        if (operation === "restore" && process.env["GITHUB_OUTPUT"]) {
          appendFileSync(process.env["GITHUB_OUTPUT"], "cache-hit=false\n");
        }
        return resolve(0);
      }
      resolve(code ?? 1);
    });
  });

const main = async () => {
  const rawOperation = process.env["INPUT_OPERATION"];
  if (rawOperation !== "restore" && rawOperation !== "save") {
    console.error("cache wrapper requires INPUT_OPERATION");
    process.exitCode = 1;
    return;
  }
  const operation: CacheOperation = rawOperation;
  const directory = mkdtempSync(path.join(tmpdir(), "stella-cache-"));
  try {
    const url = `https://raw.githubusercontent.com/actions/cache/${CACHE_REVISION}/dist/${operation}-only/index.js`;
    const download = spawnSync(
      "bun",
      ["scripts/publisher-fetch.ts", url, "--archive", directory],
      { stdio: "inherit" },
    );
    if (download.status !== 0) {
      console.log(annotation(operation, "reason=download-error"));
      return;
    }
    const worker = readdirSync(directory).find((file) =>
      file.endsWith("index.js"),
    );
    if (worker === undefined) {
      console.log(annotation(operation, "reason=download-missing"));
      return;
    }
    const entry = path.join(directory, worker);
    process.exitCode = await runCacheWorker({ operation, entry });
  } catch (error) {
    console.log(
      annotation(
        operation,
        `reason=download-error detail=${String(error).replaceAll(" ", "-")}`,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  await main();
}
