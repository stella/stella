import path from "node:path";

const DUPLICATE_CHECK = "Check that no duplicate dependencies are installed";
const EXPO_BUN_WORKSPACE_ISSUE = "https://github.com/expo/expo/issues/46429";

type DoctorClassification =
  | { type: "pass" }
  | { type: "known-bun-store-layout"; packages: string[] }
  | { type: "failure"; reason: string };

const normalizePath = (value: string) => value.replaceAll("\\", "/");

const isBunStorePath = (value: string) => {
  const normalized = normalizePath(value);
  return (
    normalized.includes("node_modules/.bun/") ||
    normalized.includes(".bun/install/cache/links/")
  );
};

const isProjectDependencyLink = (value: string) =>
  normalizePath(value).startsWith("node_modules/");

const outputLines = (output: string) =>
  output.split("\n").map((line) => line.replace(/\r$/u, ""));

const failedChecks = (output: string) =>
  outputLines(output).flatMap((line) =>
    line.startsWith("✖ ") ? [line.slice(2)] : [],
  );

const isAsciiDigits = (value: string) =>
  value.length > 0 &&
  [...value].every((character) => character >= "0" && character <= "9");

const reportsExactlyOneFailedCheck = (output: string) => {
  const summary = " checks passed. 1 checks failed.";
  return outputLines(output).some((line) => {
    const summaryStart = line.indexOf(summary);
    if (summaryStart === -1) {
      return false;
    }
    const trailingText = line.slice(summaryStart + summary.length);
    if (trailingText !== "" && trailingText !== " Possible issues detected:") {
      return false;
    }
    const counts = line.slice(0, summaryStart).split("/");
    return counts.length === 2 && counts.every((count) => isAsciiDigits(count));
  });
};

type DuplicateEntry = { name: string; version: string; path: string };
type DuplicateSection = { name: string; entries: DuplicateEntry[] };

const parseDuplicateEntry = (line: string): DuplicateEntry | null => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("├─ ") && !trimmed.startsWith("└─ ")) {
    return null;
  }

  const resolution = trimmed.slice(3);
  const pathMarker = " (at: ";
  const pathStart = resolution.lastIndexOf(pathMarker);
  if (pathStart === -1 || !resolution.endsWith(")")) {
    return null;
  }
  const versionStart = resolution.lastIndexOf("@", pathStart);
  if (versionStart <= 0) {
    return null;
  }

  return {
    name: resolution.slice(0, versionStart),
    version: resolution.slice(versionStart + 1, pathStart),
    path: resolution.slice(pathStart + pathMarker.length, -1),
  };
};

const duplicateSections = (output: string): DuplicateSection[] => {
  const sections: DuplicateSection[] = [];
  let current: DuplicateSection | null = null;

  for (const line of outputLines(output)) {
    const headerPrefix = "Found duplicates for ";
    if (line.startsWith(headerPrefix) && line.endsWith(":")) {
      current = {
        name: line.slice(headerPrefix.length, -1),
        entries: [],
      };
      sections.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    const entry = parseDuplicateEntry(line);
    if (entry !== null) {
      current.entries.push(entry);
    }
  }

  return sections;
};

export const classifyExpoDoctorResult = (
  output: string,
  exitCode: number,
): DoctorClassification => {
  if (exitCode === 0) {
    return { type: "pass" };
  }

  const checks = failedChecks(output);
  if (checks.length !== 1 || checks.at(0) !== DUPLICATE_CHECK) {
    return {
      type: "failure",
      reason:
        "Expo Doctor reported a failure other than the known Bun store layout",
    };
  }
  if (!reportsExactlyOneFailedCheck(output)) {
    return {
      type: "failure",
      reason: "Expo Doctor did not report exactly one failed check",
    };
  }

  const sections = duplicateSections(output);
  if (sections.length === 0) {
    return {
      type: "failure",
      reason: "Expo Doctor named no duplicate package groups",
    };
  }

  for (const section of sections) {
    if (section.entries.length < 2) {
      return {
        type: "failure",
        reason: `${section.name} did not contain multiple resolutions`,
      };
    }
    if (section.entries.some((entry) => entry.name !== section.name)) {
      return {
        type: "failure",
        reason: `${section.name} contained a mismatched package resolution`,
      };
    }
    const version = section.entries.at(0)?.version;
    if (section.entries.some((entry) => entry.version !== version)) {
      return {
        type: "failure",
        reason: `${section.name} resolves to multiple versions`,
      };
    }
    if (!section.entries.some((entry) => isBunStorePath(entry.path))) {
      return {
        type: "failure",
        reason: `${section.name} has no Bun store resolution`,
      };
    }
    if (
      section.entries.some(
        (entry) =>
          !isBunStorePath(entry.path) && !isProjectDependencyLink(entry.path),
      )
    ) {
      return {
        type: "failure",
        reason: `${section.name} resolves outside the project and Bun stores`,
      };
    }
  }

  return {
    type: "known-bun-store-layout",
    packages: sections.map(({ name }) => name),
  };
};

const run = async () => {
  const projectRoot = path.resolve(process.argv[2] ?? ".");
  const doctor = path.join(projectRoot, "node_modules/.bin/expo-doctor");
  const processHandle = Bun.spawn({
    cmd: [doctor, projectRoot],
    cwd: projectRoot,
    env: { ...process.env, EXPO_OFFLINE: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  const classification = classifyExpoDoctorResult(
    `${stdout}\n${stderr}`,
    exitCode,
  );
  if (classification.type === "pass") {
    return;
  }
  if (classification.type === "known-bun-store-layout") {
    console.warn(
      `Accepted Expo Doctor's known Bun isolated-store report for ${classification.packages.join(", ")}. Tracking: ${EXPO_BUN_WORKSPACE_ISSUE}`,
    );
    return;
  }

  console.warn(
    `Expo Doctor compatibility guard rejected the result: ${classification.reason}`,
  );
  process.exit(exitCode);
};

if (import.meta.main) {
  await run();
}
