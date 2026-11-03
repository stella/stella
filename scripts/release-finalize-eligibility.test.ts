import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const subject = new URL("release-finalize-eligibility.sh", import.meta.url)
  .pathname;
const REPOSITORY = "stella/stella";

type Run = {
  head_repository: { full_name: string };
  head_branch: string;
  event: string;
  path: string;
  conclusion: string;
  display_title: string;
};

type EligibilityOptions = {
  run?: (sha: string) => Partial<Run>;
  tags?: (sha: string) => string[];
};

const decide = ({ run, tags }: EligibilityOptions = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-finalize-eligible-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q", "--template=");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.test");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
    git("add", "VERSION");
    git("commit", "-qm", "chore: release v1.2.3");
    const sha = git("rev-parse", "HEAD");
    for (const tag of tags?.(sha) ?? ["v1.2.3-rc.1", "v1.2.3-rc.2"]) {
      git("tag", "-a", tag, "-m", tag, sha);
    }
    const event = path.join(root, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        workflow_run: {
          head_repository: { full_name: REPOSITORY },
          head_branch: "main",
          event: "workflow_dispatch",
          path: ".github/workflows/main-heavy.yml",
          conclusion: "success",
          display_title: `Main heavy suites ${sha}`,
          ...run?.(sha),
        },
      }),
    );
    const result = Bun.spawnSync(["bash", subject, event, REPOSITORY], {
      cwd: root,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return { sha, output: result.stdout.toString(), result };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("a successful dispatched proof of a tagged candidate is eligible", () => {
  const { sha, output } = decide();
  expect(output).toBe(`sha=${sha}\n`);
});

test("a staging run title naming the candidate tag is eligible", () => {
  const { sha, output } = decide({
    run: (commit) => ({
      path: ".github/workflows/deploy-staging.yml",
      display_title: `Staging release proof v1.2.3-rc.2 ${commit}`,
    }),
  });
  expect(output).toBe(`sha=${sha}\n`);
});

const refusals: [string, EligibilityOptions][] = [
  [
    "foreign-repository",
    { run: () => ({ head_repository: { full_name: "fork/stella" } }) },
  ],
  ["non-main-branch", { run: () => ({ head_branch: "release/v1.2.3" }) }],
  ["non-dispatch-event", { run: () => ({ event: "push" }) }],
  [
    "not-a-proof-workflow",
    { run: () => ({ path: ".github/workflows/untrusted.yml" }) },
  ],
  ["unsuccessful-proof", { run: () => ({ conclusion: "failure" }) }],
  [
    "not-a-proof-title",
    { run: (sha) => ({ display_title: `Main heavy suites ${sha.slice(7)}` }) },
  ],
  ["untagged-commit", { tags: () => [] }],
  [
    "candidate-mismatch",
    {
      run: (sha) => ({
        path: ".github/workflows/deploy-staging.yml",
        display_title: `Staging release proof v1.2.3-rc.1 ${sha}`,
      }),
    },
  ],
  ["already-final", { tags: () => ["v1.2.3-rc.2", "v1.2.3"] }],
];

for (const [reason, options] of refusals) {
  test(`${reason} refuses with its named reason and no commit`, () => {
    const { output, result } = decide(options);
    expect(output).toBe(`reason=${reason}\n`);
    expect(result.stderr.toString()).toContain(`Finalize refused (${reason})`);
  });
}

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/release-tag.yml", import.meta.url),
    "utf-8",
  ),
);
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
const job = (name: string) => field(field(workflow, "jobs"), name);

test("only the eligibility verdict starts the job that holds the release environment", () => {
  const eligibility = job("finalize-eligibility");
  expect(field(eligibility, "environment")).toBeUndefined();
  expect(JSON.stringify(eligibility)).not.toContain("secrets.");
  const finalize = job("finalize");
  expect(field(finalize, "needs")).toBe("finalize-eligibility");
  expect(field(finalize, "if")).toBe(
    "github.event_name == 'workflow_run' && needs.finalize-eligibility.outputs.sha != ''",
  );
  expect(field(finalize, "environment")).toBe("release-app");
  expect(JSON.stringify(finalize)).toContain(
    "needs.finalize-eligibility.outputs.sha",
  );
});

test("refused runs never enter a tag-writing concurrency group", () => {
  expect(field(workflow, "concurrency")).toBeUndefined();
  expect(field(job("finalize-eligibility"), "concurrency")).toBeUndefined();
  for (const name of ["tag", "finalize"]) {
    const concurrency = field(job(name), "concurrency");
    expect(typeof field(concurrency, "group")).toBe("string");
    expect(field(concurrency, "cancel-in-progress")).toBe(false);
  }
});
