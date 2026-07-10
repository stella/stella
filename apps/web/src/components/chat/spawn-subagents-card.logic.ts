type SpawnSubagent = {
  task: string;
  context?: string | undefined;
  expectedOutput?: string | undefined;
  model?: string | undefined;
};

export type KeyedSpawnSubagent<T extends SpawnSubagent> = {
  index: number;
  key: string;
  subagent: T;
};

export const keySpawnSubagents = <T extends SpawnSubagent>(
  subagents: readonly T[],
): KeyedSpawnSubagent<T>[] => {
  const occurrences = new Map<string, number>();

  return subagents.map((subagent, index) => {
    const identity = JSON.stringify([
      subagent.task,
      subagent.context ?? null,
      subagent.expectedOutput ?? null,
      subagent.model ?? null,
    ]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);

    return {
      index,
      key: `${identity}:${String(occurrence)}`,
      subagent,
    };
  });
};
