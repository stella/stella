import { request as apiRequestFactory } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { panic, Result } from "better-result";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/node";

import { apiPut, E2E_API_ORIGIN } from "./api";
import { createTestCorrespondence } from "./correspondence";
import { createUploadedDocumentRoute } from "./document";
import { e2eEnv } from "./env";
import { signInWithEmailOtp } from "./sign-in";
import type { SmokeWorld } from "./smoke-route-defs";
import { createTestWorkspace, deleteTestWorkspace } from "./workspace";

export const SMOKE_WORLD_COUNTS = { small: 100, large: 1000 } as const;
const CLEANUP_DIRECTORY = "route-smoke-scale-cleanup";
const WORLDS_FILE = "worlds.json";
const CLEANUP_RECORD_SUFFIX = ".cleanup.json";
const API_ROOT = path.resolve(import.meta.dirname, "../../../api");

const cardinalitiesSchema = v.object({
  entities: v.number(),
  documents: v.number(),
  contacts: v.number(),
  versions: v.number(),
  chatThreads: v.number(),
  listRows: v.number(),
});
export type SmokeCardinalities = v.InferOutput<typeof cardinalitiesSchema>;
export const SMOKE_WORLD_DIMENSIONS = v.keyof(cardinalitiesSchema).options;
type StorageState = Awaited<ReturnType<APIRequestContext["storageState"]>>;
export type SmokeScaleWorld = SmokeWorld & {
  storageState: StorageState;
  cardinalities: SmokeCardinalities;
};

export const assertTenfoldSmokeWorlds = ({
  small,
  large,
}: {
  small: SmokeCardinalities;
  large: SmokeCardinalities;
}): void => {
  for (const dimension of SMOKE_WORLD_DIMENSIONS) {
    if (small[dimension] <= 0 || large[dimension] !== small[dimension] * 10) {
      panic(
        `${dimension}: expected positive tenfold fixtures, observed ${small[dimension]} and ${large[dimension]}`,
      );
    }
  }
};

const storageStateSchema = v.object({
  cookies: v.array(
    v.object({
      name: v.string(),
      value: v.string(),
      domain: v.string(),
      path: v.string(),
      expires: v.number(),
      httpOnly: v.boolean(),
      secure: v.boolean(),
      sameSite: v.picklist(["Strict", "Lax", "None"]),
    }),
  ),
  origins: v.array(
    v.object({
      origin: v.string(),
      localStorage: v.array(v.object({ name: v.string(), value: v.string() })),
    }),
  ),
});
const cleanupSchema = v.object({
  organizationId: v.string(),
  workspaceId: v.nullable(v.string()),
  storageState: storageStateSchema,
});
const worldSchema = v.object({
  workspace: v.object({
    id: v.string(),
    filePropertyId: v.string(),
    viewId: v.string(),
  }),
  contactId: v.string(),
  documentRoute: v.object({ entityId: v.string(), path: v.string() }),
  correspondenceId: v.string(),
  storageState: storageStateSchema,
  cardinalities: cardinalitiesSchema,
});
const worldsSchema = v.object({ small: worldSchema, large: worldSchema });

// Sessions stay outside Playwright's uploaded artifacts. The run identifier
// comes from the coordinator process and survives worker replacement.
export const smokeWorldDirectory = (outputDirectory: string): string => {
  const runId =
    e2eEnv.routeSmokeRunId ??
    panic("Route smoke run identifier was not initialized");
  const key = sha256Hex(`${runId}\0${path.resolve(outputDirectory)}`);
  return path.join(tmpdir(), CLEANUP_DIRECTORY, key);
};

const publishCleanup = async (
  recordPath: string,
  record: v.InferOutput<typeof cleanupSchema>,
) => {
  const temporaryPath = `${recordPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(record), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, recordPath);
};

const assertResponse = async (
  response: Awaited<ReturnType<APIRequestContext["post"]>>,
) => {
  if (!response.ok()) {
    throw new Error(
      `Smoke fixture request failed (${response.status()}): ${await response.text()}`,
    );
  }
};

const seedWorld = async (
  outputDirectory: string,
  count: 100 | 1000,
): Promise<SmokeScaleWorld> => {
  const request = await apiRequestFactory.newContext({
    extraHTTPHeaders: {
      origin: e2eEnv.webOrigin,
    },
  });
  try {
    const token = randomUUID();
    const email = `route-smoke-scale-${token}@stella.dev`;
    await signInWithEmailOtp(request, email);
    const organizationResponse = await request.post(
      `${E2E_API_ORIGIN}/api/auth/organization/create`,
      {
        data: { name: "Route smoke scale", slug: `route-smoke-scale-${token}` },
      },
    );
    await assertResponse(organizationResponse);
    const { id: organizationId } = v.parse(
      v.object({ id: v.string() }),
      await organizationResponse.json(),
    );
    const directory = smokeWorldDirectory(outputDirectory);
    const recordPath = path.join(directory, `${token}${CLEANUP_RECORD_SUFFIX}`);
    const publication = await Result.tryPromise(async () => {
      const activation = await request.post(
        `${E2E_API_ORIGIN}/api/auth/organization/set-active`,
        { data: { organizationId } },
      );
      await assertResponse(activation);
      const storageState = await request.storageState();
      const record = {
        organizationId,
        workspaceId: null,
        storageState,
      } satisfies v.InferOutput<typeof cleanupSchema>;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await publishCleanup(recordPath, record);
      return record;
    });
    if (Result.isError(publication)) {
      const rollback = await Result.tryPromise(async () => {
        const response = await request.post(
          `${E2E_API_ORIGIN}/api/auth/organization/delete`,
          { data: { organizationId } },
        );
        await assertResponse(response);
        await rm(`${recordPath}.tmp`, { force: true });
      });
      if (Result.isError(rollback)) {
        throw new AggregateError(
          [publication.error, rollback.error],
          "Scale smoke setup and organization rollback failed",
        );
      }
      throw publication.error;
    }
    const record = publication.value;
    const storageState = record.storageState;
    const sessionResponse = await request.get(
      `${E2E_API_ORIGIN}/api/auth/get-session`,
      { params: { disableCookieCache: "true" } },
    );
    await assertResponse(sessionResponse);
    const {
      user: { id: userId },
    } = v.parse(
      v.object({ user: v.object({ id: v.string() }) }),
      await sessionResponse.json(),
    );
    const workspace = await createTestWorkspace(request, "route-smoke");
    const registered = await Result.tryPromise(
      async () =>
        await publishCleanup(recordPath, {
          ...record,
          workspaceId: workspace.id,
        }),
    );
    if (Result.isError(registered)) {
      await deleteTestWorkspace(request, workspace.id);
      await rm(`${recordPath}.tmp`, { force: true });
      throw registered.error;
    }
    const contactId = randomUUID();
    await apiPut(request, "/contacts", {
      id: contactId,
      type: "person",
      displayName: "Route Smoke",
      firstName: "Route",
      lastName: "Smoke",
    });
    const documentRoute = await createUploadedDocumentRoute({
      fileName: "route-smoke.docx",
      request,
      workspace,
    });
    const cardinalities = await new Promise<SmokeCardinalities>(
      (resolve, reject) => {
        execFile(
          "bun",
          [
            "scripts/seed-route-smoke-scale.ts",
            JSON.stringify({
              organizationId,
              userId,
              workspaceId: workspace.id,
              documentId: documentRoute.entityId,
              contactId,
              count,
            }),
          ],
          {
            cwd: API_ROOT,
            env: e2eEnv.seedEnvironment,
            timeout: 60_000,
          },
          (error, stdout, stderr) => {
            if (error !== null) {
              reject(
                new Error(`Scale fixture seed failed: ${stderr}`, {
                  cause: error,
                }),
              );
              return;
            }
            const parsed = Result.try(() =>
              v.parse(cardinalitiesSchema, JSON.parse(stdout)),
            );
            if (Result.isError(parsed)) {
              reject(
                new Error("Scale fixture seed returned invalid cardinalities", {
                  cause: parsed.error,
                }),
              );
              return;
            }
            resolve(parsed.value);
          },
        );
      },
    );
    const correspondenceId = await createTestCorrespondence(workspace.id, {
      organizationId,
      email,
    });
    return {
      workspace,
      contactId,
      documentRoute,
      correspondenceId,
      storageState,
      cardinalities,
    };
  } finally {
    await request.dispose();
  }
};

type SmokeWorlds = { small: SmokeScaleWorld; large: SmokeScaleWorld };
let worldsPromise: Promise<SmokeWorlds> | undefined;

// The route-smoke project has one worker. All serial groups share this one
// seed operation, while each route still opens fresh browser contexts.
export const getSmokeWorlds = async (
  outputDirectory: string,
): Promise<SmokeWorlds> => {
  worldsPromise ??= (async () => {
    const persisted = await readSmokeWorlds(outputDirectory);
    if (persisted !== null) {
      return persisted;
    }
    const small = await seedWorld(outputDirectory, SMOKE_WORLD_COUNTS.small);
    const large = await seedWorld(outputDirectory, SMOKE_WORLD_COUNTS.large);
    assertTenfoldSmokeWorlds({
      small: small.cardinalities,
      large: large.cardinalities,
    });
    const worlds = { small, large };
    const worldsPath = path.join(
      smokeWorldDirectory(outputDirectory),
      WORLDS_FILE,
    );
    await writeFile(`${worldsPath}.tmp`, JSON.stringify(worlds), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(`${worldsPath}.tmp`, worldsPath);
    return worlds;
  })();
  return await worldsPromise;
};

// A failed serial group replaces the worker. Later groups reuse the completed
// pair after verifying both its shape and every tenfold cardinality.
export const readSmokeWorlds = async (
  outputDirectory: string,
): Promise<SmokeWorlds | null> => {
  const saved = await Result.tryPromise(
    async () =>
      await readFile(
        path.join(smokeWorldDirectory(outputDirectory), WORLDS_FILE),
        "utf-8",
      ),
  );
  if (Result.isError(saved)) {
    const error = saved.error.cause;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw saved.error;
  }
  const worlds = v.parse(worldsSchema, JSON.parse(saved.value));
  assertTenfoldSmokeWorlds({
    small: worlds.small.cardinalities,
    large: worlds.large.cardinalities,
  });
  return worlds;
};

export const cleanupSmokeWorlds = async (
  outputDirectory: string,
): Promise<void> => {
  if (e2eEnv.routeSmokeRunId === undefined) {
    return;
  }
  const directory = smokeWorldDirectory(outputDirectory);
  const listing = await Result.tryPromise(async () => await readdir(directory));
  if (Result.isError(listing)) {
    const error = listing.error.cause;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw listing.error;
  }
  const records = listing.value;
  const failures: unknown[] = [];
  for (const fileName of records) {
    if (!fileName.endsWith(CLEANUP_RECORD_SUFFIX)) {
      continue;
    }
    const recordPath = path.join(directory, fileName);
    const record = v.parse(
      cleanupSchema,
      JSON.parse(await readFile(recordPath, "utf-8")),
    );
    const request = await apiRequestFactory.newContext({
      storageState: record.storageState,
      extraHTTPHeaders: {
        origin: e2eEnv.webOrigin,
      },
    });
    try {
      if (record.workspaceId !== null) {
        await deleteTestWorkspace(request, record.workspaceId);
      }
      const response = await request.post(
        `${E2E_API_ORIGIN}/api/auth/organization/delete`,
        { data: { organizationId: record.organizationId } },
      );
      await assertResponse(response);
      await rm(recordPath);
    } catch (error: unknown) {
      failures.push(error);
    } finally {
      await request.dispose();
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Scale smoke fixture cleanup failed");
  }
  await rm(directory, { recursive: true, force: true });
};
