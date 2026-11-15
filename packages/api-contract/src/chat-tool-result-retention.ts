import {
  BROWSER_CONTROL_TOOL_NAME,
  supersedeBrowserControlResult,
} from "./browser-control";

/**
 * How chat keeps a tool's earlier results once the tool returned a newer one.
 * A tool without an entry keeps every result as returned.
 *
 * `superseded-by-newer`: the tool's result is state that its own next result
 * replaces (a page read), so only the newest result `supersede` projects stays
 * whole. Every earlier one is kept as its projection, in the model's view, in
 * the stored parts and in the streamed snapshots alike, so what the model
 * read, what the page showed live and what a reload serves agree.
 */
export type ChatToolResultRetention = {
  kind: "superseded-by-newer";
  /**
   * The projection of an output a newer one replaced, or `null` for an
   * output that carries nothing a newer one replaces (an error, or an output
   * already projected). Projecting a projection must return `null`.
   */
  supersede: (output: unknown) => unknown;
};

/**
 * Keyed by tool name, not by tool definition: the persistence and stream
 * boundaries see stored parts, never the run's tool map. A policy belongs here
 * only for a tool whose results grow a turn without bound; every other read
 * is already capped where the tool returns it.
 */
const CHAT_TOOL_RESULT_RETENTION: Readonly<
  Record<string, ChatToolResultRetention>
> = {
  [BROWSER_CONTROL_TOOL_NAME]: {
    kind: "superseded-by-newer",
    supersede: supersedeBrowserControlResult,
  },
};

export const chatToolResultRetention = (
  toolName: string,
): ChatToolResultRetention | undefined =>
  Object.hasOwn(CHAT_TOOL_RESULT_RETENTION, toolName)
    ? CHAT_TOOL_RESULT_RETENTION[toolName]
    : undefined;

/** One tool result in order, as the caller's representation reads it. */
export type RetainableToolResult = {
  output: unknown;
  toolName: string;
};

export type SupersededToolResultsOptions = {
  /**
   * Whether the newest result of each tool stays whole. A conversation that
   * can still continue keeps it, since its next step reads it; a finished
   * one (a sub-agent run that returned its answer) has no next step, so
   * every result is kept as its projection.
   */
  keepNewest: boolean;
};

/**
 * The results a newer result of the same tool supersedes, each with the
 * projection to keep in its place. `results` are in turn order; `read`
 * returns `null` for an item that is not a tool result. The newest result of
 * each tool that its policy projects stays whole unless `keepNewest` is
 * false.
 */
export const supersededToolResults = <T>(
  results: readonly T[],
  read: (item: T) => RetainableToolResult | null,
  options?: SupersededToolResultsOptions,
): Map<T, unknown> => {
  const keepNewest = options?.keepNewest ?? true;
  const projected: { item: T; projection: unknown; toolName: string }[] = [];
  for (const item of results) {
    const result = read(item);
    if (result === null) {
      continue;
    }
    const retention = chatToolResultRetention(result.toolName);
    if (retention === undefined) {
      continue;
    }
    const projection = retention.supersede(result.output);
    if (projection !== null) {
      projected.push({ item, projection, toolName: result.toolName });
    }
  }
  const newestByTool = new Map<string, T>();
  for (const { item, toolName } of projected) {
    newestByTool.set(toolName, item);
  }
  return new Map(
    projected
      .filter(
        ({ item, toolName }) =>
          !keepNewest || newestByTool.get(toolName) !== item,
      )
      .map(({ item, projection }) => [item, projection] as const),
  );
};
