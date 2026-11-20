import { describe, expect, test } from "bun:test";

const WORKFLOW_URL = new URL(
  "../.github/workflows/local-run-e2e.yml",
  import.meta.url,
);
const RETRY_URL = new URL("retry.sh", import.meta.url);

// A slow but healthy mirror install takes up to about 310 s; an attempt
// deadline at or below that kills installs that would have finished.
const SLOW_HEALTHY_INSTALL_SECONDS = 310;
const INSTALL_HEADROOM = 1.3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

type AptAttempt = {
  readonly command: "update" | "install";
  readonly seconds: number;
  readonly killAfterSeconds: number;
};

const ATTEMPT_PATTERN =
  /^\s*bash scripts\/retry\.sh sudo timeout --kill-after=(\d+)s (\d+)s\s+apt-get "\$\{apt_options\[@\]\}" (update|install)\b/u;

const aptAttempts = (run: string): AptAttempt[] =>
  run
    .replaceAll("\\\n", " ")
    .split("\n")
    .filter((line) => /\bapt-get\b/u.test(line))
    .map((line) => {
      const match = ATTEMPT_PATTERN.exec(line);
      const command = match?.[3];
      if (match === null || (command !== "update" && command !== "install")) {
        throw new Error(`apt-get call without an attempt deadline: ${line}`);
      }
      return {
        command,
        seconds: Number(match[2]),
        killAfterSeconds: Number(match[1]),
      };
    });

// retry.sh's own defaults, read from the script so the deadline arithmetic
// cannot drift from what it actually does.
const retryDefault = (script: string, name: string): string => {
  const match = new RegExp(`\\$\\{${name}:-([^}]*)\\}`, "u").exec(script);
  if (match?.[1] === undefined) {
    throw new Error(`retry.sh default for ${name} not found`);
  }
  return match[1];
};

type RetryPolicy = {
  readonly attempts: number;
  readonly pauseSeconds: number;
};

const retryPolicy = async (
  env: Record<string, unknown>,
): Promise<RetryPolicy> => {
  const script = await Bun.file(RETRY_URL).text();
  const attempts = Number(
    env["RETRY_ATTEMPTS"] ?? retryDefault(script, "RETRY_ATTEMPTS"),
  );
  const delays = String(
    env["RETRY_DELAYS_SECONDS"] ?? retryDefault(script, "RETRY_DELAYS_SECONDS"),
  )
    .trim()
    .split(/\s+/u)
    .map(Number);
  let pauseSeconds = 0;
  // retry.sh pauses after every attempt but the last, repeating the final
  // delay once the list runs out.
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    pauseSeconds += delays[Math.min(attempt, delays.length) - 1] ?? 0;
  }
  return { attempts, pauseSeconds };
};

describe("local run workflow desktop library install", () => {
  test("bounds every apt attempt so a retry can follow it", async () => {
    const attempts = aptAttempts(String((await installStep())["run"]));
    expect(attempts.map(({ command }) => command)).toEqual([
      "update",
      "install",
    ]);
  });

  test("the install deadline leaves room for a slow but healthy mirror", async () => {
    const install = aptAttempts(String((await installStep())["run"])).find(
      ({ command }) => command === "install",
    );
    expect(install?.seconds).toBeGreaterThanOrEqual(
      SLOW_HEALTHY_INSTALL_SECONDS * INSTALL_HEADROOM,
    );
  });

  test("the step deadline covers every attempt and pause of every apt call", async () => {
    const step = await installStep();
    const env = isRecord(step["env"]) ? step["env"] : {};
    const { attempts, pauseSeconds } = await retryPolicy(env);
    const worstSeconds = aptAttempts(String(step["run"])).reduce(
      (total, { seconds, killAfterSeconds }) =>
        total + attempts * (seconds + killAfterSeconds) + pauseSeconds,
      0,
    );
    expect(Number(step["timeout-minutes"])).toBe(Math.ceil(worstSeconds / 60));
  });
});
