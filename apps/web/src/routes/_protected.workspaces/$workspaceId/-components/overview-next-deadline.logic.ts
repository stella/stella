type DatedTask = { dueDate: string | null };

export type NextDeadline<TTask> =
  | { type: "none" }
  | { dueDate: string; task: TTask; type: "overdue" | "upcoming" };

/**
 * The agenda arrives ordered with the oldest deadline first and undated tasks
 * last, so a deadline already missed is the one the card leads with.
 */
export const resolveNextDeadline = <TTask extends DatedTask>(
  tasks: readonly TTask[],
  today: string,
): NextDeadline<TTask> => {
  for (const task of tasks) {
    if (task.dueDate !== null) {
      return {
        dueDate: task.dueDate,
        task,
        type: task.dueDate < today ? "overdue" : "upcoming",
      };
    }
  }
  return { type: "none" };
};
