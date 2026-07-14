// `null` is not an oversight: OpenAI's strict Structured Outputs obliges the
// model to send `null` for the optional fields it omits, and this card renders
// the model's tool-call arguments.
type SpawnSubagent = {
  task: string;
  context?: string | null | undefined;
  expectedOutput?: string | null | undefined;
  model?: string | null | undefined;
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
