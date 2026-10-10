import { flagKey } from "../../../../packages/cli/src/flag-name";
import { normalizeInputKeyCasing } from "../../../../packages/cli/src/input-key-casing";
import type { LeafCommandSpec } from "../../../../packages/cli/src/route-types";
import {
  buildArgsFromFlags,
  parseInputObject,
} from "../../../../packages/cli/src/run-leaf-command";

type ComposeCliToolInputOptions = {
  spec: LeafCommandSpec;
  flags: ReadonlyMap<string, string | null>;
  repeatedFlags: ReadonlyMap<string, readonly string[]>;
};

export const composeCliToolInput = async ({
  spec,
  flags,
  repeatedFlags,
}: ComposeCliToolInputOptions) => {
  const inputRaw = flags.get("input");
  // Scoring never reads model-authored file paths or standard input.
  if (
    inputRaw === "-" ||
    inputRaw?.startsWith("@") === true ||
    flags.has("file")
  ) {
    return { ok: false, message: "scoring requires inline input" } as const;
  }
  const messages: string[] = [];
  const base =
    typeof inputRaw === "string"
      ? await parseInputObject({
          inputRaw,
          writers: {
            stdout: (message) => messages.push(message),
            stderr: (message) => messages.push(message),
          },
        })
      : {};
  if (base === undefined) {
    return { ok: false, message: messages.join("").trim() } as const;
  }
  const cased = normalizeInputKeyCasing({
    args: base,
    inputSchema: spec.inputSchema,
  });
  if (cased.status === "conflict") {
    return {
      ok: false,
      message: `conflicting input keys ${cased.camel} and ${cased.snake}`,
    } as const;
  }
  const values: Record<string, unknown> = {};
  for (const flag of spec.flags) {
    const name = flag.flag.replace(/^--/u, "");
    if (!flags.has(name)) {
      continue;
    }
    const raw = flags.get(name);
    const entries =
      repeatedFlags.get(name) ?? (typeof raw === "string" ? [raw] : []);
    if (
      entries.some((entry) => entry.startsWith("@") && !entry.startsWith("@@"))
    ) {
      return {
        ok: false,
        message: "scoring requires inline flag values",
      } as const;
    }
    if (flag.kind === "boolean") {
      if (raw !== null && raw !== "true" && raw !== "false") {
        return { ok: false, message: `invalid boolean --${name}` } as const;
      }
      values[flagKey(flag)] = raw !== "false";
      continue;
    }
    if (raw === null) {
      return { ok: false, message: `missing value --${name}` } as const;
    }
    values[flagKey(flag)] = flag.repeatable ? [...entries] : raw;
  }
  const built = await buildArgsFromFlags(spec, values, cased.args);
  if (!built.ok) {
    return built;
  }
  const args = { ...built.args, ...spec.discriminatorInject };
  if (
    (spec.destructive || spec.confirmPassthrough === true) &&
    flags.has("yes")
  ) {
    const properties = spec.inputSchema["properties"];
    if (
      typeof properties === "object" &&
      properties !== null &&
      "confirm" in properties
    ) {
      args["confirm"] = true;
    }
  }
  return { ok: true, args } as const;
};
