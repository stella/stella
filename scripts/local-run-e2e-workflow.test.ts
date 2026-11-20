import { describe, expect, test } from "bun:test";

const WORKFLOW_URL = new URL(
  "../.github/workflows/local-run-e2e.yml",
  import.meta.url,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// retry.sh defaults: three attempts, pausing 15 s and then 45 s.
const RETRY_ATTEMPTS = 3;
const RETRY_PAUSE_SECONDS = 15 + 45;
const KILL_AFTER_SECONDS = 10;

const installStep = async (): Promise<Record<string, unknown>> => {
  const workflow: unknown = Bun.YAML.parse(await Bun.file(WORKFLOW_URL).text());
  const jobs =
    isRecord(workflow) && isRecord(workflow["jobs"]) ? workflow["jobs"] : {};
  const standIn = isRecord(jobs["stand-in"]) ? jobs["stand-in"] : {};
  const steps = Array.isArray(standIn["steps"]) ? standIn["steps"] : [];
  const step: unknown = steps.find(
    (candidate: unknown) =>
      isRecord(candidate) &&
      candidate["name"] === "Install desktop build libraries",
  );
  if (!isRecord(step)) {
    throw new Error("Install desktop build libraries step not found");
  }
  return step;
};

describe("local run workflow desktop library install", () => {
  test("bounds every apt attempt so a retry can follow it", async () => {
    const run = String((await installStep())["run"]);
    const commands = run
      .replaceAll("\\\n", " ")
      .split("\n")
      .filter((line) => /\bapt-get\b/u.test(line));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toMatch(
        /^\s*bash scripts\/retry\.sh sudo timeout --kill-after=10s \d+s\s+apt-get /u,
      );
    }
  });

  test("the step deadline covers every attempt of every apt call", async () => {
    const step = await installStep();
    const run = String(step["run"]);
    const attemptSeconds = [
      ...run.matchAll(/sudo timeout --kill-after=10s (\d+)s/gu),
    ].map((match) => Number(match[1]));
    expect(attemptSeconds).toHaveLength(2);
    const worstSeconds = attemptSeconds.reduce(
      (total, seconds) =>
        total +
        RETRY_ATTEMPTS * (seconds + KILL_AFTER_SECONDS) +
        RETRY_PAUSE_SECONDS,
      0,
    );
    expect(Number(step["timeout-minutes"]) * 60).toBeGreaterThanOrEqual(
      worstSeconds,
    );
  });
});
