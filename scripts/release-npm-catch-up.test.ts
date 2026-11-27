import { describe, expect, test } from "bun:test";

import {
  collectCatchUpState,
  decideCatchUp,
  SOURCE_JOB,
  tagForPublication,
} from "./release-npm-catch-up.mjs";

const run = (
  overrides: Partial<{
    id: number;
    event: string;
    status: string;
    conclusion: string | null;
    created_at: string;
    updated_at: string;
  }> = {},
) => ({
  id: 1,
  event: "workflow_run",
  status: "completed",
  conclusion: "success",
  created_at: "2026-01-01T10:00:00Z",
  updated_at: "2026-01-01T10:10:00Z",
  ...overrides,
});

const releaseDone = run({
  event: "push",
  created_at: "2026-01-01T09:00:00Z",
  updated_at: "2026-01-01T09:40:00Z",
});

describe("decideCatchUp", () => {
  test("waits while the final release run is going, although the pull request merged and npm lacks the version", () => {
    // The release pull request now merges right after finalization, before
    // the final release run starts the release's own publication. Dispatching
    // here would publish beside that publication.
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: run({
          event: "push",
          status: "in_progress",
          conclusion: null,
        }),
        publications: [],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: false });
  });

  test("waits while the release's own publication is going", () => {
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [
          {
            ...run({ status: "in_progress", conclusion: null }),
            refusedAtSource: false,
          },
        ],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: false });
  });

  test("waits until the release's own publication has started", () => {
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: false });
  });

  test("leaves a publication that passed its source check to its own alert", () => {
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [
          { ...run({ conclusion: "failure" }), refusedAtSource: false },
        ],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: false });
  });

  test("dispatches once the own publication refused before the pull request merged", () => {
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [
          { ...run({ conclusion: "failure" }), refusedAtSource: true },
        ],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: true });
  });

  test("does nothing before the pull request merged", () => {
    expect(
      decideCatchUp({
        releasePullMerged: false,
        releaseRun: releaseDone,
        publications: [
          { ...run({ conclusion: "failure" }), refusedAtSource: true },
        ],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: false });
  });

  test("does nothing when npm serves the version or a manual publication succeeded", () => {
    const refused = {
      ...run({ conclusion: "failure" }),
      refusedAtSource: true,
    };
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [refused],
        npmStatus: 200,
      }),
    ).toMatchObject({ dispatch: false });
    expect(
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [
          refused,
          {
            ...run({ id: 2, event: "workflow_dispatch" }),
            refusedAtSource: false,
          },
        ],
        npmStatus: 404,
      }),
    ).toMatchObject({ dispatch: false });
  });

  test("fails when npm does not answer", () => {
    expect(() =>
      decideCatchUp({
        releasePullMerged: true,
        releaseRun: releaseDone,
        publications: [
          { ...run({ conclusion: "failure" }), refusedAtSource: true },
        ],
        npmStatus: 503,
      }),
    ).toThrow("npm did not answer");
  });
});

describe("tagForPublication", () => {
  const releaseRuns = [
    {
      ...run({ event: "push", updated_at: "2026-01-01T09:40:00Z" }),
      head_branch: "v1.2.3",
    },
    {
      ...run({ event: "push", updated_at: "2026-01-01T09:45:00Z" }),
      head_branch: "v1.2.4-rc.1",
    },
    {
      ...run({ event: "push", updated_at: "2026-01-01T11:00:00Z" }),
      head_branch: "v1.2.4",
    },
    {
      ...run({
        event: "workflow_dispatch",
        updated_at: "2026-01-01T09:50:00Z",
      }),
      head_branch: "v1.2.2",
    },
  ];

  test("names the newest final tag whose release run completed before the publication", () => {
    expect(tagForPublication(releaseRuns, "2026-01-01T09:41:00Z")).toBe(
      "v1.2.3",
    );
    expect(tagForPublication(releaseRuns, "2026-01-01T11:00:30Z")).toBe(
      "v1.2.4",
    );
  });

  test("names nothing before any final release run completed", () => {
    expect(tagForPublication(releaseRuns, "2026-01-01T09:00:00Z")).toBeNull();
  });
});

describe("collectCatchUpState", () => {
  const manifest = {
    content: Buffer.from(JSON.stringify({ version: "8.6.0" })).toString(
      "base64",
    ),
    encoding: "base64",
  };

  const client = ({
    releaseRuns,
    publishRuns,
    sourceConclusion,
  }: {
    releaseRuns: ReturnType<typeof run>[];
    publishRuns: ReturnType<typeof run>[];
    sourceConclusion: string;
  }) => {
    const publishQueries: unknown[] = [];
    const github = {
      rest: {
        pulls: {
          list: async () => ({ data: [{ merged_at: "2026-01-01T09:10:00Z" }] }),
        },
        actions: {
          listWorkflowRuns: async (options: { workflow_id: string }) => {
            if (options.workflow_id === "publish-npm.yml") {
              publishQueries.push(options);
            }
            return {
              data: {
                workflow_runs:
                  options.workflow_id === "release.yml"
                    ? releaseRuns
                    : publishRuns,
              },
            };
          },
          listJobsForWorkflowRun: async () => ({
            data: {
              jobs: [{ name: SOURCE_JOB, conclusion: sourceConclusion }],
            },
          }),
        },
        repos: { getContent: async () => ({ data: manifest }) },
      },
    };
    return { github, publishQueries };
  };

  const context = { repo: { owner: "owner", repo: "repo" } };

  test("reads no publication while the release run is going", async () => {
    const { github, publishQueries } = client({
      releaseRuns: [
        run({ event: "push", status: "in_progress", conclusion: null }),
      ],
      publishRuns: [],
      sourceConclusion: "success",
    });
    const state = await collectCatchUpState({
      github,
      context,
      tag: "v1.2.3",
      fetchStatus: async () => 404,
    });
    expect(publishQueries).toEqual([]);
    expect(decideCatchUp(state)).toMatchObject({ dispatch: false });
    expect(state.version).toBe("8.6.0");
  });

  test("marks the release's own publication as refused from its source job", async () => {
    const { github } = client({
      releaseRuns: [releaseDone],
      publishRuns: [
        run({ id: 7, event: "push", created_at: "2026-01-01T09:41:00Z" }),
        run({
          id: 8,
          conclusion: "failure",
          created_at: "2026-01-01T09:41:30Z",
        }),
      ],
      sourceConclusion: "failure",
    });
    const state = await collectCatchUpState({
      github,
      context,
      tag: "v1.2.3",
      fetchStatus: async () => 404,
    });
    expect(
      state.publications.map(({ id, refusedAtSource }) => [
        id,
        refusedAtSource,
      ]),
    ).toEqual([[8, true]]);
    expect(decideCatchUp(state)).toMatchObject({ dispatch: true });
  });
});
