import type { APIRequestContext, FullConfig } from "@playwright/test";
import { request as apiRequestFactory } from "@playwright/test";
import { panic } from "better-result";
import path from "node:path";

import { apiDelete } from "./helpers/api";
import {
  clearDeferredE2eCleanup,
  E2E_CLEANUP_TARGET_TYPE,
  type E2eCleanupTarget,
  readDeferredE2eCleanup,
} from "./helpers/deferred-cleanup";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const cleanupTarget = async (
  request: APIRequestContext,
  target: E2eCleanupTarget,
): Promise<void> => {
  switch (target.type) {
    case E2E_CLEANUP_TARGET_TYPE.CONTACT:
      await apiDelete(request, `/contacts/${target.id}`);
      return;
    case E2E_CLEANUP_TARGET_TYPE.WORKSPACE:
      await apiDelete(request, `/workspaces/${target.id}`);
      return;
    default:
      target satisfies never;
      return panic(`Unhandled target: ${String(target)}`);
  }
};

const cleanupTargets = async (
  request: APIRequestContext,
  targets: E2eCleanupTarget[],
): Promise<unknown[]> => {
  const results = await Promise.allSettled(
    targets.map(async (target) => {
      await cleanupTarget(request, target);
    }),
  );
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      failures.push(reason);
    }
  }
  return failures;
};

const globalTeardown = async (config: FullConfig): Promise<void> => {
  const outputDirectories = [
    ...new Set(config.projects.map((project) => project.outputDir)),
  ];
  const cleanupByDirectory = await Promise.all(
    outputDirectories.map(async (outputDirectory) => ({
      outputDirectory,
      result: await readDeferredE2eCleanup(outputDirectory),
    })),
  );
  const targets = cleanupByDirectory.flatMap(({ result }) => result.targets);
  const failures = cleanupByDirectory.flatMap(({ result }) => result.failures);

  if (targets.length === 0) {
    if (failures.length > 0) {
      throw new AggregateError(failures, "Deferred E2E fixture cleanup failed");
    }
    return;
  }

  const apiRequest = await apiRequestFactory.newContext({
    storageState: STORAGE_STATE,
  });
  failures.push(
    ...(await cleanupTargets(
      apiRequest,
      targets.filter(
        (target) => target.type === E2E_CLEANUP_TARGET_TYPE.CONTACT,
      ),
    )),
  );
  failures.push(
    ...(await cleanupTargets(
      apiRequest,
      targets.filter(
        (target) => target.type === E2E_CLEANUP_TARGET_TYPE.WORKSPACE,
      ),
    )),
  );
  try {
    await apiRequest.dispose();
  } catch (error: unknown) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Deferred E2E fixture cleanup failed");
  }

  await Promise.all(
    cleanupByDirectory
      .filter(({ result }) => result.targets.length > 0)
      .map(async ({ outputDirectory }) => {
        await clearDeferredE2eCleanup(outputDirectory);
      }),
  );
};

export default globalTeardown;
