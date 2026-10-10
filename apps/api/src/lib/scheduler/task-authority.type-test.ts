import type {
  SchedulerTaskAuthorityEntry,
  SchedulerTaskAuthorityRegistry,
} from "@/api/lib/scheduler/task-authority";

const automation = {
  authority: "org-automation",
  module: "apps/api/src/lib/scheduler/tasks/example.ts",
  reason: "Example.",
} as const satisfies SchedulerTaskAuthorityEntry;

// A registry that leaves a registered task unclassified does not compile.
// @ts-expect-error Every registered scheduler task needs an authority row.
export const unclassified: SchedulerTaskAuthorityRegistry = {
  "scheduler.noop": automation,
};

// Nor does one that classifies a task the scheduler registry does not run.
export const unknownTask = {
  // @ts-expect-error Only registered scheduler tasks can be classified.
  "unregistered.task": automation,
} satisfies Partial<SchedulerTaskAuthorityRegistry>;

// A member run must say whether it settles its member's access when it runs.
// @ts-expect-error A member-run row declares its run actor (or null).
export const memberRunWithoutActor: SchedulerTaskAuthorityEntry = {
  authority: "member-run",
  module: "apps/api/src/lib/scheduler/tasks/example.ts",
  reason: "Example.",
};

// The resolver is one of the calls that settle a member's access.
export const unknownResolver: SchedulerTaskAuthorityEntry = {
  authority: "member-run",
  module: "apps/api/src/lib/scheduler/tasks/example.ts",
  reason: "Example.",
  runActor: {
    module: "apps/api/src/lib/scheduler/tasks/example.ts",
    // @ts-expect-error Only a listed resolver settles a member's access.
    resolver: "readUserFromPayload",
  },
};
