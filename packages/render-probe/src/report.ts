import { RENDER_CAUSES, type RenderSnapshot } from "./probe";

/**
 * The components that rendered most, widest first, as a table a failure
 * message or a measurement log can carry.
 */
export const formatRenderReport = (
  snapshot: RenderSnapshot,
  { top = 15 }: { top?: number } = {},
): string => {
  const rows = Object.entries(snapshot.components)
    .toSorted(([, left], [, right]) => right.renders - left.renders)
    .slice(0, top);
  const nameWidth = Math.max(9, ...rows.map(([name]) => name.length));
  const header = [
    "component".padEnd(nameWidth),
    "renders".padStart(8),
    ...RENDER_CAUSES.map((cause) => cause.padStart(8)),
  ].join(" ");
  const lines = rows.map(([name, entry]) =>
    [
      name.padEnd(nameWidth),
      String(entry.renders).padStart(8),
      ...RENDER_CAUSES.map((cause) => String(entry.causes[cause]).padStart(8)),
    ].join(" "),
  );
  return [
    `${String(snapshot.commits)} commits, ${String(snapshot.renders)} component renders, widest commit ${String(snapshot.widestCommit)}, ${String(snapshot.causes.parent)} with unchanged props`,
    header,
    ...lines,
  ].join("\n");
};
