import measurements from "./ci-install-measurements.json" with { type: "json" };

class InstallMeasurementInvariantError extends Error {
  override name = "InstallMeasurementInvariantError";
  readonly _tag = "InstallMeasurementInvariantError";
}

type InstallClassOptions = {
  platform: NodeJS.Platform;
  flags: readonly string[];
};

export const installClassKey = ({ platform, flags }: InstallClassOptions) => {
  const filters: string[] = [];
  const globalPackages: string[] = [];
  const otherFlags: string[] = [];
  for (const [index, flag] of flags.entries()) {
    const next = flags.at(index + 1);
    const previous = flags.at(index - 1);
    if (
      index > 0 &&
      previous &&
      ["--filter", "-g", "--global"].includes(previous)
    ) {
      continue;
    }
    if (flag.startsWith("--filter=")) {
      filters.push(flag.slice("--filter=".length));
    } else if (flag === "--filter" && next) {
      filters.push(next);
    } else if ((flag === "-g" || flag === "--global") && next) {
      const name = /^((?:@[^/]+\/)?[^@]+)(?:@.*)?$/u.exec(next)?.at(1);
      if (name) {
        globalPackages.push(name);
      }
    } else if (
      !["--production", "--frozen-lockfile", "--ignore-scripts"].includes(flag)
    ) {
      otherFlags.push(flag);
    }
  }
  let mode = flags.includes("--production") ? "production" : "development";
  if (globalPackages.length > 0) {
    mode = `global:${[...new Set(globalPackages)].toSorted().join(",")}`;
    if (flags.includes("--production")) {
      mode += ":production";
    }
  }
  const parts = [
    platform,
    mode,
    flags.includes("--frozen-lockfile") ? "frozen" : "mutable",
    flags.includes("--ignore-scripts") ? "ignored" : "scripts",
    [...new Set(filters)].toSorted().join(",") || "all",
  ];
  if (otherFlags.length > 0) {
    parts.push(JSON.stringify(otherFlags));
  }
  return parts.join("|");
};

export const measuredInstallBudget = (
  options: InstallClassOptions,
  table = measurements,
) => {
  const key = installClassKey(options);
  const measurement = table.classes.find((entry) => entry.key === key);
  if (!measurement) {
    throw new InstallMeasurementInvariantError(
      `Missing install class measurement entry: ${key}`,
    );
  }
  if (measurement.status === "unmeasured") {
    return {
      key,
      status: measurement.status,
      timeoutMs: measurement.currentBudgetMs,
      p95Ms: undefined,
    };
  }
  const completed = measurement.samples
    .filter(
      (sample) => sample.cache === "cold" && sample.outcome === "completed",
    )
    .map((sample) => sample.durationMs)
    .toSorted((left, right) => left - right);
  const p95Ms = completed.at(Math.ceil(completed.length * 0.95) - 1);
  if (p95Ms === undefined) {
    throw new InstallMeasurementInvariantError(
      `No completed cold samples for measured install class: ${key}`,
    );
  }
  return {
    key,
    status: measurement.status,
    p95Ms,
    timeoutMs: Math.ceil((p95Ms + table.marginMs) / 1000) * 1000,
  };
};
