const DEFAULT_PRODUCTION_API_URL = "https://api.stll.app";
const DEFAULT_MAX_LAG_COMMITS = 100;
const DEFAULT_MAX_LAG_HOURS = 7 * 24;
const FETCH_TIMEOUT_MS = 10_000;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

class ProductionFreshnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionFreshnessError";
  }
}

type ProductionFreshnessInput = {
  lagCommits: number;
  lagHours: number;
  maxLagCommits: number;
  maxLagHours: number;
};

type ProductionFreshnessResult =
  | { status: "current" }
  | { reasons: string[]; status: "stale" };

export const evaluateProductionFreshness = ({
  lagCommits,
  lagHours,
  maxLagCommits,
  maxLagHours,
}: ProductionFreshnessInput): ProductionFreshnessResult => {
  const reasons: string[] = [];

  if (lagCommits > maxLagCommits) {
    reasons.push(
      `production is ${lagCommits} commits behind main (maximum ${maxLagCommits})`,
    );
  }
  if (lagHours > maxLagHours) {
    reasons.push(
      `the oldest unreleased main commit has waited ${Math.floor(lagHours)} hours (maximum ${maxLagHours})`,
    );
  }

  if (reasons.length > 0) {
    return { reasons, status: "stale" };
  }
  return { status: "current" };
};

const readPositiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProductionFreshnessError(
      `${name} must be a positive integer; received ${raw}`,
    );
  }
  return value;
};

const stripTrailingSlash = (value: string) => value.replace(/\/+$/u, "");

const readProductionCommit = async (apiUrl: string) => {
  const healthUrl = new URL("/health", `${stripTrailingSlash(apiUrl)}/`);
  const response = await fetch(healthUrl, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ProductionFreshnessError(
      `${healthUrl.toString()} returned HTTP ${response.status}`,
    );
  }

  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductionFreshnessError(
      "production /health did not return an object",
    );
  }

  const commit = Reflect.get(value, "commit");
  if (typeof commit !== "string" || !COMMIT_SHA_PATTERN.test(commit)) {
    throw new ProductionFreshnessError(
      "production /health did not return a full lowercase commit SHA",
    );
  }
  return commit;
};

const runGit = async (args: string[]) => {
  const process = Bun.spawn(["git", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new ProductionFreshnessError(
      `git ${args.join(" ")} failed: ${stderr.trim()}`,
    );
  }
  return stdout.trim();
};

const readLag = async (productionCommit: string) => {
  await runGit(["merge-base", "--is-ancestor", productionCommit, "HEAD"]);

  const [lagCommitsRaw, unreleasedCommitEpochs] = await Promise.all([
    runGit(["rev-list", "--count", `${productionCommit}..HEAD`]),
    runGit(["log", "--reverse", "--format=%ct", `${productionCommit}..HEAD`]),
  ]);
  const lagCommits = Number(lagCommitsRaw);
  const oldestUnreleasedCommitEpochRaw = unreleasedCommitEpochs
    .split("\n")
    .find(Boolean);
  const oldestUnreleasedCommitEpoch = oldestUnreleasedCommitEpochRaw
    ? Number(oldestUnreleasedCommitEpochRaw)
    : undefined;
  if (!Number.isSafeInteger(lagCommits)) {
    throw new ProductionFreshnessError(
      "git returned invalid production freshness metadata",
    );
  }
  if (
    lagCommits > 0 &&
    (oldestUnreleasedCommitEpoch === undefined ||
      !Number.isSafeInteger(oldestUnreleasedCommitEpoch))
  ) {
    throw new ProductionFreshnessError(
      "git returned no timestamp for the oldest unreleased commit",
    );
  }

  const lagHours = oldestUnreleasedCommitEpoch
    ? Math.max(0, Date.now() / 3_600_000 - oldestUnreleasedCommitEpoch / 3600)
    : 0;
  return { lagCommits, lagHours };
};

const appendSummary = async (lines: string[]) => {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (!summaryPath) {
    return;
  }
  await Bun.write(summaryPath, `${lines.join("\n")}\n`);
};

const main = async () => {
  const apiUrl =
    process.env["PRODUCTION_API_URL"]?.trim() || DEFAULT_PRODUCTION_API_URL;
  const maxLagCommits = readPositiveInteger(
    "MAX_PRODUCTION_LAG_COMMITS",
    DEFAULT_MAX_LAG_COMMITS,
  );
  const maxLagHours = readPositiveInteger(
    "MAX_PRODUCTION_LAG_HOURS",
    DEFAULT_MAX_LAG_HOURS,
  );
  const productionCommit = await readProductionCommit(apiUrl);
  const { lagCommits, lagHours } = await readLag(productionCommit);
  const result = evaluateProductionFreshness({
    lagCommits,
    lagHours,
    maxLagCommits,
    maxLagHours,
  });
  const facts = [
    "## Production freshness",
    "",
    `- Production commit: \`${productionCommit}\``,
    `- Main HEAD: \`${await runGit(["rev-parse", "HEAD"])}\``,
    `- Commit lag: ${lagCommits} (maximum ${maxLagCommits})`,
    `- Oldest unreleased change: ${Math.floor(lagHours)} hours (maximum ${maxLagHours})`,
  ];
  await appendSummary(facts);

  if (result.status === "stale") {
    throw new ProductionFreshnessError(result.reasons.join("; "));
  }
  console.log(
    `production-freshness: ok (${lagCommits} commits, ${Math.floor(lagHours)} hours)`,
  );
};

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`production-freshness: ${message}`);
    process.exit(1);
  });
}
