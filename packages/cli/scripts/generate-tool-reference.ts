import { panic, Result } from "better-result";

import { formattedLikeRepository } from "../../scripts/src/generated-artifact-format";
import registry from "../src/generated/registry-snapshot.json";
import { generatedRouteMap } from "../src/generated/route-map";
import type { RegistryToolListing, RouteNode } from "../src/route-types";
import { writeGeneratedFile } from "../src/write-generated-file";

type ToolReferenceRow = {
  access: "destructive" | "read" | "write";
  command: string[];
  description: string;
  name: string;
  title: string;
};

/** The documentation projection shares the exact tree the CLI executes. */
export const projectToolReference = (
  tree: RouteNode,
  listings: readonly RegistryToolListing[],
): ToolReferenceRow[] => {
  const registryByName = new Map(listings.map((tool) => [tool.name, tool]));
  const visit = (node: RouteNode): ToolReferenceRow[] => {
    switch (node.kind) {
      case "route":
        return Object.values(node.children).flatMap(visit);
      case "capability-leaf":
        return [
          {
            access: node.spec.destructive ? "destructive" : node.spec.access,
            command: [...node.spec.commandPath],
            description:
              node.spec.description ?? `Invoke ${node.spec.capabilityId}.`,
            name: `capability:${node.spec.capabilityId}`,
            title: node.spec.capabilityId,
          },
        ];
      case "leaf": {
        const tool =
          registryByName.get(node.spec.toolName) ??
          panic(
            `CLI documentation references unknown tool ${node.spec.toolName}`,
          );
        let access: ToolReferenceRow["access"] = "write";
        if (node.spec.destructive) {
          access = "destructive";
        } else if (tool.annotations?.readOnlyHint) {
          access = "read";
        }
        return [
          {
            access,
            command: [...node.spec.commandPath],
            description: tool.description,
            name: tool.name,
            title: tool.annotations?.title ?? tool.name,
          },
        ];
      }
      default:
        node satisfies never;
        return panic("Unknown CLI route kind");
    }
  };
  return visit(tree);
};

if (import.meta.main) {
  const output = new URL(
    "../src/generated/tool-reference.json",
    import.meta.url,
  );
  const content = await formattedLikeRepository(
    JSON.stringify(projectToolReference(generatedRouteMap, registry)),
    "json",
    new URL("../../../", import.meta.url).pathname,
  );
  if (process.argv.includes("--check")) {
    if ((await Bun.file(output).text()) !== content) {
      process.stderr.write(
        "CLI tool-reference documentation is stale; run full CLI codegen.\n",
      );
      process.exit(1);
    }
    process.exit(0);
  }
  const written = await writeGeneratedFile({ output, content });
  if (Result.isError(written)) {
    process.stderr.write(`${written.error.message}\n`);
    process.exit(1);
  }
}
