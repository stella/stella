#!/usr/bin/env bun
import {
  checkRegistry,
  DAY_SECONDS,
  readPackageManifest,
  versionBumpTime,
  type RegistryResult,
} from "./check-npm-publish-lag";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

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
          const manifest = readPackageManifest({
            directory,
            text: contents,
            policy: "journey",
          });
          if (history !== undefined && manifest !== undefined) {
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
