import { panic } from "better-result";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";
import type { TanStackAIProvider } from "@stll/ai-catalog";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

// The structure of the requests a provider is sent, as a set of JSON paths
// (`input[].content[].type`: array positions collapse to `[]`), committed as
// an inventory. A change that makes an adapter send a path the inventory
// lacks fails the provider request schema test until the inventory is
// updated on purpose, so a new field on the wire is always reviewed and
// always reached by a conversation the schema check runs.

const INVENTORY_FILE = path.resolve(
  import.meta.dir,
  "../fixtures/provider-request-schemas/request-paths.json",
);

/** Rewrites the inventory from what the conversations sent. Never in CI. */
export const UPDATE_REQUEST_PATHS_ENV = "UPDATE_PROVIDER_REQUEST_PATHS";

/**
 * Subtrees whose keys are data rather than request structure: a tool's own
 * input schema, a tool call's arguments, a tool result's value. The path of
 * the subtree is kept; what is under it is not.
 */
export const OPAQUE_REQUEST_PATHS = {
  anthropic: ["messages[].content[].input", "tools[].input_schema"],
  bedrock: [
    "messages[].content[].toolResult.content[].json",
    "messages[].content[].toolUse.input",
    "toolConfig.tools[].toolSpec.inputSchema.json",
  ],
  google: [
    "contents[].parts[].functionCall.args",
    "contents[].parts[].functionResponse.response",
    "tools[].functionDeclarations[].parameters",
    "tools[].functionDeclarations[].parametersJsonSchema",
  ],
  mistral: ["tools[].function.parameters"],
  openai: ["text.format.schema", "tools[].parameters"],
  openrouter: ["tools[].function.parameters"],
} as const satisfies Record<TanStackAIProvider, readonly string[]>;

/** Every JSON path in `body`, stopping at the `opaque` subtrees. */
export const requestPathsOf = (
  body: unknown,
  opaque: readonly string[],
): Set<string> => {
  const paths = new Set<string>();
  const visit = (value: unknown, at: string) => {
    if (at !== "") {
      paths.add(at);
    }
    if (opaque.includes(at)) {
      return;
    }
    if (isUnknownArray(value)) {
      for (const item of value) {
        visit(item, `${at}[]`);
      }
      return;
    }
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        visit(child, at === "" ? key : `${at}.${key}`);
      }
    }
  };
  visit(body, "");
  return paths;
};

type Inventory = Partial<Record<TanStackAIProvider, readonly string[]>>;

export const readRequestPathInventory = (): Inventory => {
  const parsed: unknown = JSON.parse(readFileSync(INVENTORY_FILE, "utf-8"));
  if (!isRecord(parsed)) {
    return panic("The request path inventory is an object");
  }
  const inventory: Inventory = {};
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const paths = parsed[provider];
    if (isUnknownArray(paths)) {
      inventory[provider] = paths.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  }
  return inventory;
};

/** Whether this run rewrites the inventory instead of checking it. */
export const updatingRequestPaths = (): boolean => {
  if (process.env[UPDATE_REQUEST_PATHS_ENV] !== "1") {
    return false;
  }
  if (process.env["CI"] !== undefined && process.env["CI"] !== "") {
    return panic("CI checks the request path inventory; it never updates it");
  }
  return true;
};

/** Replaces `provider`'s entry in the committed inventory. */
export const writeRequestPaths = (
  provider: TanStackAIProvider,
  paths: ReadonlySet<string>,
) => {
  const inventory = readRequestPathInventory();
  const next: Inventory = { ...inventory, [provider]: [...paths].toSorted() };
  const ordered = Object.fromEntries(
    TANSTACK_AI_PROVIDERS.flatMap((key) => {
      const entry = next[key];
      return entry === undefined ? [] : [[key, entry]];
    }),
  );
  writeFileSync(INVENTORY_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
};

/** How the paths a conversation sent differ from the inventory, one line
 *  per path. */
export const findRequestPathDrift = ({
  inventory,
  provider,
  sent,
}: {
  inventory: readonly string[];
  provider: TanStackAIProvider;
  sent: ReadonlySet<string>;
}): string[] => {
  const known = new Set(inventory);
  const update = `re-run with ${UPDATE_REQUEST_PATHS_ENV}=1`;
  return [
    ...[...sent]
      .filter((entry) => !known.has(entry))
      .toSorted()
      .map(
        (entry) =>
          `new request path ${provider}:${entry} not in the inventory: add a scenario that covers it and ${update}`,
      ),
    ...[...known]
      .filter((entry) => !sent.has(entry))
      .toSorted()
      .map(
        (entry) =>
          `request path ${provider}:${entry} is in the inventory but no longer sent: ${update}`,
      ),
  ];
};
