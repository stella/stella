import { Glob } from "bun";
import path from "node:path";
import ts from "typescript6";

import { MCP_STATIC_TOOL_NAMES } from "@/api/mcp/static-tool-names";

export const readRouteSurface = (file: string, source: string): string[] => {
  if (!/new Elysia\s*\(/u.test(source)) {
    return [];
  }
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const ids: string[] = [];
  const occurrences = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      node.arguments.length >= 2
    ) {
      const route = node.arguments.at(0);
      if (route !== undefined) {
        const routeName = ts.isStringLiteralLike(route)
          ? route.text
          : route.getText(parsed);
        const id = `GET ${file} ${routeName}`;
        const occurrence = (occurrences.get(id) ?? 0) + 1;
        occurrences.set(id, occurrence);
        ids.push(occurrence === 1 ? id : `${id} #${occurrence}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return ids;
};

/** Route declarations and the closed tool-name registry own membership. */
export const discoverReadScalingSurface = async () => {
  const root = path.resolve(import.meta.dir, "../../../../..");
  const ids = MCP_STATIC_TOOL_NAMES.filter((name) =>
    /^(list|read|search)_/u.test(name),
  ).map((name) => `MCP ${name}`);
  for await (const file of new Glob("apps/api/src/**/*.ts").scan({
    cwd: root,
  })) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(path.join(root, file)).text();
    ids.push(...readRouteSurface(file, source));
  }
  return [...new Set(ids)].toSorted();
};

export const scalingCoverageViolations = ({
  surface,
  measured,
  exemptions,
}: {
  surface: readonly string[];
  measured: readonly string[];
  exemptions: readonly { id: string; reason: string }[];
}) => {
  const existing = new Set(surface);
  const measuredIds = new Set(measured);
  const exemptIds = new Set(exemptions.map(({ id }) => id));
  return [
    ...surface
      .filter((id) => !measuredIds.has(id) && !exemptIds.has(id))
      .map((id) => `unmeasured: ${id}`),
    ...measured
      .filter((id) => !existing.has(id))
      .map((id) => `stale scenario: ${id}`),
    ...exemptions.flatMap(({ id, reason }) => [
      ...(!existing.has(id) ? [`stale exemption: ${id}`] : []),
      ...(measuredIds.has(id) ? [`remove measured exemption: ${id}`] : []),
      ...(reason.trim().length < 12 ? [`exemption needs a reason: ${id}`] : []),
    ]),
    ...(exemptIds.size !== exemptions.length ? ["duplicate exemptions"] : []),
    ...(measuredIds.size !== measured.length ? ["duplicate scenarios"] : []),
  ];
};
