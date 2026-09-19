import { expect, type TestInfo } from "@playwright/test";
import { Result } from "better-result";
import { readFile, writeFile } from "node:fs/promises";

import { apiStatus } from "../helpers/api";
import { setFixedBrowserTime } from "../helpers/clock";
import {
  E2E_CLEANUP_TARGET_TYPE,
  registerDeferredE2eCleanup,
} from "../helpers/deferred-cleanup";
import { createUploadedDocumentRoute } from "../helpers/document";
import { test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";
import { WORKSPACE_REPLAY_ENV } from "./env";
import {
  BoundedEventTrail,
  MAX_REPLAY_STEPS,
  REPLAY_ARTIFACT_VERSION,
  REPLAY_FIXTURE_NAME,
  parseReplayArtifact,
  serializeReplayArtifact,
  type ReplayArtifact,
  type ReplayEvent,
  type ReplayTrailEvent,
} from "./replay-artifact";
import {
  SeededRandom,
  hasWorkspaceAction,
  selectWeightedAction,
} from "./workspace-actions";
import {
  assertWorkspaceInvariants,
  availableWorkspaceActions,
  executeWorkspaceAction,
  readWorkspaceState,
  trackApiFailures,
  type WorkspaceDriverContext,
} from "./workspace-driver";

const DEFAULT_SEED = 20_260_919;
const DEFAULT_STEPS = 25;
const FIXED_TIME = "2026-09-19T12:00:00.000Z";
const FIXTURE_FILE_NAME = "workspace-replay.docx";
const COLD_START_TIMEOUT_MS = 120_000;

type RunConfig = {
  seed: number;
  steps: number;
  replay: ReplayArtifact | null;
};

const readInteger = ({
  defaultValue,
  maximum,
  minimum,
  name,
  raw,
}: {
  defaultValue: number;
  maximum: number;
  minimum: number;
  name: string;
  raw: string | undefined;
}): number => {
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a safe integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
};

const readRunConfig = async (): Promise<RunConfig> => {
  const replayPath = WORKSPACE_REPLAY_ENV.replayPath;
  if (replayPath !== undefined) {
    const serialized = await readFile(replayPath, "utf-8");
    const decoded = Result.try((): unknown => JSON.parse(serialized));
    if (Result.isError(decoded)) {
      throw new TypeError(`E2E_SOAK_REPLAY is not valid JSON: ${replayPath}`, {
        cause: decoded.error.cause,
      });
    }
    const replay = parseReplayArtifact(decoded.value);
    return { seed: replay.seed, steps: replay.events.length, replay };
  }

  return {
    seed: readInteger({
      defaultValue: DEFAULT_SEED,
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: Number.MIN_SAFE_INTEGER,
      name: "E2E_SOAK_SEED",
      raw: WORKSPACE_REPLAY_ENV.seed,
    }),
    steps: readInteger({
      defaultValue: DEFAULT_STEPS,
      maximum: MAX_REPLAY_STEPS,
      minimum: 1,
      name: "E2E_SOAK_STEPS",
      raw: WORKSPACE_REPLAY_ENV.steps,
    }),
    replay: null,
  };
};

const fileFieldIdFromRoute = (route: string): string => {
  const fieldId = new URL(route, "http://localhost").searchParams.get("field");
  if (fieldId === null) {
    throw new Error("Synthetic document route is missing its file field");
  }
  return fieldId;
};

const attachReplayArtifact = async ({
  artifact,
  name,
  testInfo,
}: {
  artifact: ReplayArtifact;
  name: string;
  testInfo: TestInfo;
}) => {
  const artifactPath = testInfo.outputPath(name);
  await writeFile(artifactPath, serializeReplayArtifact(artifact), {
    encoding: "utf-8",
  });
  await testInfo.attach(name, {
    contentType: "application/json",
    path: artifactPath,
  });
  return artifactPath;
};

const shellAssignment = (name: string, value: string): string =>
  `${name}='${value.replaceAll("'", `'"'"'`)}'`;

const replayCommand = (artifactPath: string): string =>
  [
    ...(WORKSPACE_REPLAY_ENV.webUrlOverride === undefined
      ? []
      : [
          shellAssignment(
            "E2E_WEB_URL",
            WORKSPACE_REPLAY_ENV.webUrlOverride,
          ),
        ]),
    ...(WORKSPACE_REPLAY_ENV.apiUrlOverride === undefined
      ? []
      : [
          shellAssignment(
            "E2E_API_URL",
            WORKSPACE_REPLAY_ENV.apiUrlOverride,
          ),
        ]),
    shellAssignment("E2E_SOAK_REPLAY", artifactPath),
    "bun --filter @stll/web test:e2e:soak",
  ].join(" ");

test("deterministically explores the synthetic matter workspace", async ({
  browserErrors,
  page,
  request,
}, testInfo) => {
  const run = await readRunConfig();
  const workspace = await createTestWorkspace(request, "workspace-replay");
  const registered = await Result.tryPromise(
    async () =>
      await registerDeferredE2eCleanup(testInfo.project.outputDir, {
        type: E2E_CLEANUP_TARGET_TYPE.WORKSPACE,
        id: workspace.id,
      }),
  );
  if (Result.isError(registered)) {
    const cleanup = await Result.tryPromise(
      async () => await deleteTestWorkspace(request, workspace.id),
    );
    if (Result.isError(cleanup)) {
      throw new AggregateError(
        [registered.error.cause, cleanup.error.cause],
        "Replay fixture registration and rollback both failed",
      );
    }
    throw registered.error.cause;
  }

  const documentRoute = await createUploadedDocumentRoute({
    fileName: FIXTURE_FILE_NAME,
    request,
    workspace,
  });
  const { cookies } = await request.storageState();
  await page.context().addCookies(cookies);
  await page.setViewportSize(
    run.replay?.viewport ?? { width: 1440, height: 900 },
  );
  await setFixedBrowserTime(page, FIXED_TIME);

  await expect
    .poll(
      async () =>
        await apiStatus(page.request, `/workspaces/${workspace.id}`),
      {
        message: "browser context can read the synthetic matter",
        timeout: 10_000,
      },
    )
    .toBe(200);
  await page.goto(`/workspaces/${workspace.id}/${workspace.viewId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });

  const httpFailures = trackApiFailures(page);
  const context: WorkspaceDriverContext = {
    page,
    browserErrors,
    workspaceId: workspace.id,
    document: {
      entityId: documentRoute.entityId,
      fieldId: fileFieldIdFromRoute(documentRoute.path),
      fileName: FIXTURE_FILE_NAME,
    },
    history: { back: [], forward: [] },
    httpFailures,
  };
  const random = new SeededRandom(run.seed);
  const events: ReplayEvent[] = [];
  const trail = new BoundedEventTrail<ReplayTrailEvent>();
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error("Workspace replay requires a fixed browser viewport");
  }

  const artifact = (): ReplayArtifact => ({
    version: REPLAY_ARTIFACT_VERSION,
    seed: run.seed,
    stepLimit: run.replay?.stepLimit ?? run.steps,
    commit: WORKSPACE_REPLAY_ENV.commit,
    locale: "en-US",
    viewport,
    fixture: {
      kind: "synthetic-workspace",
      name: REPLAY_FIXTURE_NAME,
    },
    events,
  });

  let currentEvent: ReplayEvent | null = null;
  let failure: ReplayTrailEvent["failure"];
  try {
    await assertWorkspaceInvariants(context);
    for (let step = 0; step < run.steps; step += 1) {
      const before = await readWorkspaceState(context);
      const candidates = await availableWorkspaceActions(context);
      const applicableActions = candidates.map(({ action }) => action);
      const recorded = run.replay?.events.at(step);

      if (recorded !== undefined) {
        expect(
          before,
          `replay state diverged before step ${String(step)}`,
        ).toEqual(recorded.before);
        expect(
          applicableActions,
          `applicable action set diverged at step ${String(step)}`,
        ).toEqual(recorded.applicableActions);
      }

      const action =
        recorded?.action ?? selectWeightedAction(random, candidates);
      expect(
        hasWorkspaceAction(candidates, action),
        `recorded action is unavailable at step ${String(step)}: ${JSON.stringify(action)}`,
      ).toBe(true);

      currentEvent = { step, action, applicableActions, before };
      events.push(currentEvent);
      failure = "action-failed";
      await executeWorkspaceAction(context, action);
      failure = "invariant-failed";
      await assertWorkspaceInvariants(context);
      const after = await readWorkspaceState(context);
      currentEvent.after = after;
      trail.add(currentEvent);

      if (recorded?.after !== undefined) {
        expect(
          after,
          `replay state diverged after step ${String(step)}`,
        ).toEqual(recorded.after);
      }
      currentEvent = null;
      failure = undefined;
    }

    const artifactPath = await attachReplayArtifact({
      artifact: artifact(),
      name: "workspace-replay.json",
      testInfo,
    });
    console.log(`[workspace-replay] replay with ${replayCommand(artifactPath)}`);
  } catch (error: unknown) {
    if (currentEvent !== null) {
      trail.add({
        ...currentEvent,
        failure: failure ?? "action-failed",
      });
    }
    const artifactPath = await attachReplayArtifact({
      artifact: artifact(),
      name: "workspace-replay.json",
      testInfo,
    });
    const trailPath = testInfo.outputPath("workspace-replay-trail.json");
    await writeFile(
      trailPath,
      `${JSON.stringify(trail.toArray(), null, 2)}\n`,
      {
        encoding: "utf-8",
      },
    );
    await testInfo.attach("workspace-replay-trail.json", {
      contentType: "application/json",
      path: trailPath,
    });
    console.error(
      `[workspace-replay] failure replay: ${replayCommand(artifactPath)}`,
    );
    throw error;
  } finally {
    httpFailures.dispose();
  }
});
