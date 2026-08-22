#!/usr/bin/env bun
// Force dependency review to name both published versions. Bun's one-argument
// form compares the lockfile against a moving "latest" target, which is useful
// interactively but cannot produce a reproducible review artifact.

const args = Bun.argv.slice(2);
const [packageAtVersion, toVersion] = args;
const versionSeparator = packageAtVersion?.lastIndexOf("@") ?? -1;
const packageName = packageAtVersion?.slice(0, versionSeparator) ?? "";
const fromVersion = packageAtVersion?.slice(versionSeparator + 1) ?? "";
const PACKAGE_NAME_PATTERN = /^(?:@[^/]+\/)?[^/@]+$/u;
const EXACT_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

if (
  args.length < 2 ||
  args.length > 3 ||
  !PACKAGE_NAME_PATTERN.test(packageName) ||
  !EXACT_VERSION_PATTERN.test(fromVersion) ||
  !EXACT_VERSION_PATTERN.test(toVersion ?? "")
) {
  console.error(
    "Usage: bun run dependencies:diff <package>@<from-version> <to-version> [glob]",
  );
  process.exit(2);
}

const child = Bun.spawn(["bun", "--no-env-file", "pm", "diff", ...args], {
  stderr: "inherit",
  stdin: "inherit",
  stdout: "inherit",
});
process.exit(await child.exited);
