#!/usr/bin/env bun
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const DAY_SECONDS = 24 * 60 * 60;
const SEMVER = /^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u;

type RegistryResult =
  | { status: "passed"; reason: "ok" }
  | { status: "skipped"; reason: "publish_pending" }
  | {
      status: "failed";
      reason: "http_status" | "timeout" | "contract_error" | "version_mismatch";
    };

export const versionBumpTime = (history: string): number | undefined => {
  for (const commit of history.split("journey-commit ").slice(1)) {
    const timestamp = Number(commit.split("\n").at(0));
    const oldVersion = /^-\s*"version"\s*:\s*"([^"]+)"/mu.exec(commit)?.at(1);
    const newVersion = /^\+\s*"version"\s*:\s*"([^"]+)"/mu.exec(commit)?.at(1);
    if (
      oldVersion &&
      newVersion &&
      oldVersion !== newVersion &&
      Number.isFinite(timestamp)
    ) {
      return timestamp;
    }
  }
  return undefined;
};

type CheckRegistryOptions = {
  name: string;
  version: string;
  bumpedAt: number | undefined;
  now: number;
  registry: string;
  timeoutMs: number;
};

// This is the network boundary: exceptions become fixed, credential-free reasons.
export const checkRegistry = async ({
  name,
  version,
  bumpedAt,
  now,
  registry,
  timeoutMs,
}: CheckRegistryOptions): Promise<RegistryResult> => {
  try {
    const response = await fetch(
      `${registry.replace(/\/$/u, "")}/${encodeURIComponent(name)}/latest`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) {
      return { status: "failed", reason: "http_status" };
    }
    const payload: unknown = await response.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("version" in payload) ||
      typeof payload.version !== "string" ||
      !SEMVER.test(payload.version)
    ) {
      return { status: "failed", reason: "contract_error" };
    }
    if (payload.version === version) {
      return { status: "passed", reason: "ok" };
    }
    if (
      bumpedAt !== undefined &&
      bumpedAt <= now &&
      now - bumpedAt < DAY_SECONDS
    ) {
      return { status: "skipped", reason: "publish_pending" };
    }
    return { status: "failed", reason: "version_mismatch" };
  } catch (error) {
    return {
      status: "failed",
      reason:
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "contract_error",
    };
  }
};

const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0
    ? new TextDecoder().decode(result.stdout)
    : undefined;
};

if (import.meta.main) {
  const ref = process.env["JOURNEY_MAIN_REF"] ?? "origin/main";
  const registry =
    process.env["JOURNEY_NPM_REGISTRY_URL"] ?? "https://registry.npmjs.org";
  const timeoutMs = Number(
    process.env["JOURNEY_REGISTRY_TIMEOUT_MS"] ?? "10000",
  );
  const now = Math.floor(Date.now() / 1000);
  let failed = false;
  // Batches bound network concurrency and keep the five-minute workflow budget.
  for (let offset = 0; offset < ALL_PACKAGE_ORDER.length; offset += 4) {
    const results = await Promise.all(
      ALL_PACKAGE_ORDER.slice(offset, offset + 4).map(async (directory) => {
        let result: RegistryResult = {
          status: "failed",
          reason: "contract_error",
        };
        try {
          const path = `packages/${directory}/package.json`;
          const contents = git(["show", `${ref}:${path}`]);
          const history = git([
            "log",
            ref,
            `--since=@${now - DAY_SECONDS}`,
            "--format=journey-commit %ct",
            "-p",
            "-G",
            '"version"[[:space:]]*:',
            "--",
            path,
          ]);
          const manifest: unknown =
            contents === undefined ? null : JSON.parse(contents);
          if (
            history !== undefined &&
            typeof manifest === "object" &&
            manifest !== null &&
            "name" in manifest &&
            manifest.name === `@stll/${directory}` &&
            "version" in manifest &&
            typeof manifest.version === "string" &&
            SEMVER.test(manifest.version)
          ) {
            result = await checkRegistry({
              name: manifest.name,
              version: manifest.version,
              bumpedAt: versionBumpTime(history),
              now,
              registry,
              timeoutMs,
            });
          }
        } catch {
          // The command boundary reports malformed manifests without their contents.
          result = { status: "failed", reason: "contract_error" };
        }
        console.log(
          `journey registry-@stll/${directory} ${result.status} ${result.reason}`,
        );
        return result;
      }),
    );
    if (results.some((result) => result.status === "failed")) {
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
