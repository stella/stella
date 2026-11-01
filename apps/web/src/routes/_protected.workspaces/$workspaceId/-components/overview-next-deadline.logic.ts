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
  const task = tasks.find(({ dueDate }) => dueDate !== null);
  if (task === undefined || task.dueDate === null) {
    return { type: "none" };
  }
  return {
    dueDate: task.dueDate,
    task,
    type: task.dueDate < today ? "overdue" : "upcoming",
  };
};
