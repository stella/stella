import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as v from "valibot";

import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/bot-refresh-auto-merge.yml", import.meta.url),
    "utf-8",
  ),
);
const steps = workflowJobSteps(workflow, "arm");
const step = (name: string) => workflowStepByName(steps, name);
const selection = v.parse(
  v.object({ script: v.string() }),
  step("Select generated refresh")["with"],
).script;
const script = new Script(`(async () => { ${selection} })()`);
const fixture = (branch = "chore/provenance-update") => {
  const summary = {
    number: 42,
    state: "open",
    draft: false,
    user: { type: "Bot", login: "stella-provenance-updater[bot]" },
    head: {
      sha: "current-head",
      ref: branch,
      repo: { full_name: "stella/stella" },
    },
    base: { ref: "main", repo: { full_name: "stella/stella" } },
  };
  const pull = { ...structuredClone(summary), changed_files: 1 };
  const file = {
    filename:
      branch === "chore/provenance-update"
        ? "provenance/projects/root/sbom.cdx.json"
        : "packages/ai-catalog/src/model-rates.gen.ts",
    status: "modified",
  };
  return {
    summary,
    pull,
    file,
    run: { head_sha: "current-head", head_branch: branch },
    pulls: [summary],
    latest: structuredClone(pull),
    files: [file],
  };
};
const select = async (input: ReturnType<typeof fixture>) => {
  const outputs: Record<string, string> = {};
  const routes: string[] = [];
  let detailReads = 0;
  await script.runInNewContext({
    context: {
      repo: { owner: "stella", repo: "stella" },
      payload: { workflow_run: input.run },
    },
    core: {
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
    },
    github: {
      paginate: async (route: string, params: Record<string, unknown>) => {
        routes.push(route);
        expect(params["per_page"]).toBe(100);
        return route.endsWith("/pulls") ? input.pulls : input.files;
      },
      rest: {
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => {
            expect(pull_number).toBe(input.pull.number);
            routes.push("GET /repos/{owner}/{repo}/pulls/{pull_number}");
            detailReads += 1;
            return { data: detailReads === 1 ? input.pull : input.latest };
          },
        },
      },
    },
  });
  return { outputs, routes };
};

for (const branch of ["chore/provenance-update", "bot/model-catalog-refresh"]) {
  test(`only a current generated refresh is selected: ${branch}`, async () => {
    const input = fixture(branch);
    expect(input.summary).not.toHaveProperty("changed_files");
    expect(input.pull.changed_files).toBe(1);
    const result = await select(input);
    expect(result.outputs).toEqual({ number: "42", head: "current-head" });
    expect(result.routes).toEqual([
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });
}

type Fixture = ReturnType<typeof fixture>;
const invalid: { name: string; change: (input: Fixture) => void }[] = [
  {
    name: "wrong author",
    change: ({ pull }) => {
      pull.user.login = "other[bot]";
    },
  },
  {
    name: "human author",
    change: ({ pull }) => {
      pull.user.type = "User";
    },
  },
  {
    name: "fork head",
    change: ({ pull }) => {
      pull.head.repo.full_name = "fork/stella";
    },
  },
  {
    name: "fork base",
    change: ({ pull }) => {
      pull.base.repo.full_name = "fork/stella";
    },
  },
  {
    name: "wrong base",
    change: ({ pull }) => {
      pull.base.ref = "release";
    },
  },
  {
    name: "wrong branch",
    change: ({ pull }) => {
      pull.head.ref = "feature";
    },
  },
  {
    name: "unknown matching branch",
    change: (input) => {
      input.run.head_branch = "feature";
      input.pull.head.ref = "feature";
    },
  },
  {
    name: "wrong path",
    change: ({ file }) => {
      file.filename = ".provenance.yml";
    },
  },
  {
    name: "other refresh class",
    change: (input) => {
      input.file.filename =
        input.run.head_branch === "chore/provenance-update"
          ? "packages/ai-catalog/src/capabilities.gen.ts"
          : "provenance/report.json";
    },
  },
  {
    name: "mixed paths",
    change: (input) => {
      input.files.push({
        filename: "apps/api/src/index.ts",
        status: "modified",
      });
      input.pull.changed_files = 2;
    },
  },
  {
    name: "deletion",
    change: ({ file }) => {
      file.status = "removed";
    },
  },
  {
    name: "rename",
    change: ({ file }) => {
      file.status = "renamed";
    },
  },
  {
    name: "incomplete pagination",
    change: ({ pull }) => {
      pull.changed_files = 2;
    },
  },
  {
    name: "no files",
    change: (input) => {
      input.files = [];
      input.pull.changed_files = 0;
    },
  },
  {
    name: "draft",
    change: ({ pull }) => {
      pull.draft = true;
    },
  },
  {
    name: "closed",
    change: ({ pull }) => {
      pull.state = "closed";
    },
  },
  {
    name: "stale run",
    change: ({ pull }) => {
      pull.head.sha = "new-head";
    },
  },
  {
    name: "head changed during selection",
    change: ({ latest }) => {
      latest.head.sha = "new-head";
    },
  },
  {
    name: "became draft",
    change: ({ latest }) => {
      latest.draft = true;
    },
  },
  {
    name: "closed during selection",
    change: ({ latest }) => {
      latest.state = "closed";
    },
  },
  {
    name: "ambiguous proposals",
    change: (input) => {
      input.pulls.push(structuredClone(input.summary));
    },
  },
];
for (const branch of ["chore/provenance-update", "bot/model-catalog-refresh"]) {
  for (const { name, change } of invalid) {
    test(`unsafe generated refresh is rejected: ${branch}, ${name}`, async () => {
      const input = fixture(branch);
      change(input);
      expect((await select(input)).outputs).toEqual({});
    });
  }
}

test("automatic merging uses only API actions and pins the validated head", () => {
  expect(
    steps.some((candidate) =>
      String(candidate["uses"] ?? "").includes("checkout"),
    ),
  ).toBe(false);
  const token = v.parse(
    v.record(v.string(), v.unknown()),
    step("Mint merge token")["with"],
  );
  expect(
    Object.fromEntries(
      Object.entries(token).filter(([name]) => name.startsWith("permission-")),
    ),
  ).toEqual({
    "permission-contents": "write",
    "permission-pull-requests": "write",
  });
  const merge = step("Enable automatic refresh merge");
  expect(merge["run"]).toBe(
    'gh pr merge "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --auto --match-head-commit "$EXPECTED_HEAD"',
  );
  expect(merge["env"]).toMatchObject({
    GH_TOKEN: `\${{ steps.app-token.outputs.token }}`,
    PR_NUMBER: `\${{ steps.refresh.outputs.number }}`,
    EXPECTED_HEAD: `\${{ steps.refresh.outputs.head }}`,
  });
  expect(merge["if"]).toBe("steps.refresh.outputs.number != ''");
});
