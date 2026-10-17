export type McpResponseConformanceObservation = {
  toolName: string;
  schema: Readonly<Record<string, unknown>>;
  result: unknown;
  issuePaths: readonly string[];
};

export type McpResponseConformanceObserver = (
  observation: McpResponseConformanceObservation,
) => void;

let observer: McpResponseConformanceObserver | undefined;

export const setMcpResponseConformanceObserver = (
  next: McpResponseConformanceObserver | undefined,
): (() => void) => {
  const previous = observer;
  observer = next;
  return () => {
    observer = previous;
  };
};

/** Observe at the existing validator; failures must escape the tool error boundary. */
export const observeMcpResponseConformance = (
  observation: McpResponseConformanceObservation,
): void => {
  observer?.(observation);
};
