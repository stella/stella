import { Result, TaggedError } from "better-result";

const GROUP_START = "##[group]";
const GROUP_END = "##[endgroup]";

export type CiCoverageEvidence =
  | { profile: "normal-v1" }
  | { profile: "pilot-fast-v1"; jobs: string[] };

export class CiCoverageLogError extends TaggedError("CiCoverageLogError")<{
  message: string;
}> {}

const error = (message: string) =>
  Result.err(new CiCoverageLogError({ message }));

const logLine = (line: string) => {
  const timestamp =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z[ \t]/u.exec(line)?.[0];
  return {
    text: timestamp === undefined ? line : line.slice(timestamp.length),
    timestamped: timestamp !== undefined,
  };
};
type LogLine = ReturnType<typeof logLine>;

type LogGroup = { start: number; end: number };
type EnvironmentSection = { index: number; values: Map<string, string[]> };

const logGroups = (lines: readonly LogLine[]) => {
  const open: number[] = [];
  const groups: LogGroup[] = [];
  for (const [index, entry] of lines.entries()) {
    if (!entry.timestamped) {
      continue;
    }
    const line = entry.text;
    if (line.trimStart().startsWith(GROUP_START)) {
      open.push(index);
      continue;
    }
    if (line.trim() !== GROUP_END) {
      continue;
    }
    const start = open.pop();
    if (start === undefined) {
      return error("CI log contains an unmatched endgroup");
    }
    groups.push({ start, end: index });
  }
  if (open.length > 0) {
    return error("CI log contains an incomplete group");
  }
  return Result.ok(groups);
};

const environmentSections = (
  lines: readonly LogLine[],
  group: LogGroup,
): EnvironmentSection[] => {
  const sections: EnvironmentSection[] = [];
  for (let index = group.start + 1; index < group.end; index += 1) {
    const headerLine = lines[index];
    if (!headerLine?.timestamped || headerLine.text.trim() !== "env:") {
      continue;
    }
    const envIndent = /^\s*/u.exec(headerLine.text)?.[0].length ?? 0;
    const values = new Map<string, string[]>();
    let activeName: string | undefined;
    for (let child = index + 1; child < group.end; child += 1) {
      const entryLine = lines[child];
      // GitHub timestamps entry starts, but leaves multiline continuations raw.
      // Raw values cannot terminate env, introduce keys, or forge group markers.
      if (!entryLine?.timestamped) {
        const entries =
          activeName === undefined ? undefined : values.get(activeName);
        const previous = entries?.pop();
        if (previous !== undefined && entryLine) {
          entries?.push(`${previous}\n${entryLine.text}`);
        }
        continue;
      }
      const line = entryLine.text;
      if (line.trim() === "") {
        continue;
      }
      const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (indent <= envIndent) {
        break;
      }
      const entry = line.trim();
      const separator = entry.indexOf(":");
      const name = entry.slice(0, separator);
      activeName = undefined;
      if (name !== "COVERAGE_PROFILE" && name !== "PILOT_FAST_JOBS") {
        continue;
      }
      activeName = name;
      const entries = values.get(name) ?? [];
      entries.push(entry.slice(separator + 1).trim());
      values.set(name, entries);
    }
    sections.push({ index, values });
  }
  return sections;
};

const coverageEvidence = (
  values: ReadonlyMap<string, readonly string[]>,
): Result<CiCoverageEvidence, CiCoverageLogError> => {
  const profiles = values.get("COVERAGE_PROFILE") ?? [];
  const jobValues = values.get("PILOT_FAST_JOBS") ?? [];
  if (profiles.length !== 1 || jobValues.length !== 1) {
    return error(
      "CI coverage env must set each coverage variable exactly once",
    );
  }
  const profile = profiles.at(0);
  const jobs = jobValues.at(0);
  if (profile === undefined || jobs === undefined) {
    return error("CI coverage env is missing coverage evidence");
  }
  if (profile === "normal-v1" && jobs === "") {
    return Result.ok({ profile });
  }
  const parsedJobs = Result.try((): unknown => JSON.parse(jobs));
  if (parsedJobs.isErr() || !Array.isArray(parsedJobs.value)) {
    return error("PILOT_FAST_JOBS must be a JSON array of unique job ids");
  }
  const jobIds = parsedJobs.value.filter(
    (job): job is string =>
      typeof job === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(job),
  );
  if (
    jobIds.length !== parsedJobs.value.length ||
    new Set(jobIds).size !== jobIds.length
  ) {
    return error("PILOT_FAST_JOBS must be a JSON array of unique job ids");
  }
  switch (profile) {
    case "normal-v1":
      return Result.ok({ profile });
    case "pilot-fast-v1":
      return jobIds.length === 0
        ? error("pilot-fast-v1 requires at least one selected fast job")
        : Result.ok({ profile, jobs: jobIds });
    default:
      return error("Unknown CI coverage profile");
  }
};

/** Reads the coverage env embedded in the CI-result job's command group. */
export const parseCiCoverageLog = (
  raw: string,
): Result<CiCoverageEvidence, CiCoverageLogError> => {
  const lines = raw.split(/\r?\n/u).map(logLine);
  const groupsResult = logGroups(lines);
  if (groupsResult.isErr()) {
    return groupsResult;
  }

  const candidateSections = groupsResult.value.flatMap((group) =>
    environmentSections(lines, group).filter(
      (section) =>
        section.values.has("COVERAGE_PROFILE") ||
        section.values.has("PILOT_FAST_JOBS"),
    ),
  );
  if (candidateSections.length !== 1) {
    return error(
      `Expected one env block with CI coverage evidence, found ${candidateSections.length}`,
    );
  }
  const section = candidateSections.at(0);
  if (section === undefined) {
    return error("CI coverage env is missing");
  }

  const containingGroups = groupsResult.value.filter(
    (group) => group.start < section.index && section.index < group.end,
  );
  if (containingGroups.length !== 1) {
    return error(
      `Expected one command group containing CI coverage env, found ${containingGroups.length}`,
    );
  }
  return coverageEvidence(section.values);
};
