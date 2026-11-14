import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  readStagingEcsReadiness,
  RECEIPT_NOT_PRODUCED,
} from "./staging-ecs-readiness";

const COMMIT = "a".repeat(40);
const current = { startedBy: "ecs-svc/current", lastStatus: "RUNNING" };
const receipt = () => ({
  commit: COMMIT,
  scope: ["api", "web"],
  services: ["api", "web"].map((service) => ({
    service,
    deploymentId: "ecs-svc/current",
    tasks: [current],
  })),
});

const readReceipt = async (value: unknown) => {
  const directory = await mkdtemp(
    path.resolve(import.meta.dir, "../.ecs-readiness-test-"),
  );
  try {
    const file = path.join(directory, "receipt.json");
    if (value !== undefined) {
      await writeFile(file, JSON.stringify(value));
    }
    return await readStagingEcsReadiness(file, COMMIT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("every scoped service has running capacity from its current deployment", async () => {
  expect(await readReceipt(receipt())).toEqual({ status: "ready" });
});

test("an absent receipt is unrecorded, never ready and never silent", async () => {
  expect(await readReceipt(undefined)).toEqual({
    status: "unrecorded",
    reason: RECEIPT_NOT_PRODUCED,
  });
});

test("mismatched and incomplete deployment evidence is unavailable", async () => {
  const missingService = receipt();
  missingService.services.pop();
  const oldTask = receipt();
  for (const service of oldTask.services) {
    service.tasks = [{ startedBy: "ecs-svc/previous", lastStatus: "RUNNING" }];
  }
  const pending = receipt();
  for (const service of pending.services) {
    service.tasks = [{ ...current, lastStatus: "PENDING" }];
  }
  for (const fixture of [
    null,
    {},
    { ...receipt(), commit: "b".repeat(40) },
    { ...receipt(), scope: [] },
    { ...receipt(), services: [receipt().services[0], receipt().services[0]] },
    {
      ...receipt(),
      services: receipt().services.map((service) => ({
        ...service,
        tasks: [{ ...current, lastStatus: "STOPPED" }],
      })),
    },
    missingService,
    oldTask,
    pending,
  ]) {
    expect(await readReceipt(fixture)).toMatchObject({
      status: "environment-unavailable",
    });
  }
});

test("a current deployment initialization stop remains unavailable after recovery", async () => {
  const stoppedReason =
    "ResourceInitializationError: unable to pull secrets or registry auth\n::warning::fixture";
  const value = receipt();
  const withStop = {
    ...value,
    services: value.services.map((service) => ({
      ...service,
      tasks: [
        ...service.tasks,
        { ...current, lastStatus: "STOPPED", stoppedReason },
      ],
    })),
  };
  expect(await readReceipt(withStop)).toEqual({
    status: "environment-unavailable",
    reason: `Deployment ECS task initialization failed: ${stoppedReason}`,
  });
  expect(
    await readReceipt({
      ...withStop,
      services: withStop.services.map((service) => ({
        ...service,
        tasks: service.tasks.map((task) =>
          task.lastStatus === "STOPPED"
            ? { ...task, startedBy: "ecs-svc/previous" }
            : task,
        ),
      })),
    }),
  ).toEqual({ status: "ready" });
});
