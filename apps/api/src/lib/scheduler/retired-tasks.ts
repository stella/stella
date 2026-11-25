/**
 * Task names an earlier build ran and a later build removed. Job registration
 * disables persisted rows only for these: a task this build does not know may
 * belong to a newer build rolling out beside it, and disabling its row would
 * stop that build's job until one of its replicas boots again.
 *
 * Removing a task from the registry moves its name here; `task-names.json`
 * only grows and must equal the registered and retired names together
 * (`task-names.test.ts`), so a removal cannot skip this list.
 */
export const RETIRED_SCHEDULER_TASK_NAMES: ReadonlySet<string> =
  new Set<string>();
