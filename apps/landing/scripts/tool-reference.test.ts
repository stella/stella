import { expect, test } from "bun:test";

test("landing compiler tasks consume committed documentation without API generators", () => {
  const run = Bun.spawnSync(
    [
      process.execPath,
      "node_modules/turbo/bin/turbo",
      "run",
      "build",
      "typecheck",
      "dev",
      "lint",
      "lint:fix",
      "--filter=@stll/landing",
      "--dry=json",
    ],
    {
      cwd: new URL("../../../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const plan: unknown = JSON.parse(run.stdout.toString());
  if (
    typeof plan !== "object" ||
    plan === null ||
    !("tasks" in plan) ||
    !Array.isArray(plan.tasks)
  ) {
    throw new TypeError("Turbo did not return its task plan");
  }
  const tasks: readonly unknown[] = plan.tasks;
  const landingTasks: string[] = [];
  for (const task of tasks) {
    if (
      typeof task !== "object" ||
      task === null ||
      !("taskId" in task) ||
      typeof task.taskId !== "string" ||
      !("command" in task) ||
      typeof task.command !== "string"
    ) {
      throw new TypeError(
        "Turbo returned a task without its identity or command",
      );
    }
    expect(task.taskId).not.toMatch(/^@stll\/(?:api|cli)#/u);
    if (!task.taskId.startsWith("@stll/landing#")) {
      continue;
    }
    landingTasks.push(task.taskId);
    expect(task.command).not.toMatch(
      /codegen:runtime|generate:capabilities|apps\/api/u,
    );
  }
  expect(landingTasks.toSorted()).toEqual([
    "@stll/landing#build",
    "@stll/landing#dev",
    "@stll/landing#lint",
    "@stll/landing#lint:fix",
    "@stll/landing#transit",
    "@stll/landing#typecheck",
  ]);
});
