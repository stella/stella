/**
 * Writing a resolved value back where the fill bag holds it.
 *
 * A fill bag mixes flat dotted keys with nested objects, and the deterministic
 * fill steps (a registry lookup's rendering, a formatted date) have to put
 * their result exactly where `resolvePath` found the input. One writer, so a
 * step cannot invent a second key for the same path.
 */

import { isRecord } from "@/api/lib/type-guards";

import type { RichPatchValue } from "./types";

/** Replace the value at `path` where `resolvePath` found it: the exact flat
 *  dotted key when present, otherwise the nested leaf. */
export const replaceResolvedValue = (
  values: Record<string, unknown>,
  path: string,
  value: RichPatchValue,
): void => {
  if (Object.hasOwn(values, path)) {
    values[path] = value;
    return;
  }
  const segments = path.split(".");
  let current: Record<string, unknown> = values;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }
  const leaf = segments.at(-1);
  if (leaf !== undefined) {
    current[leaf] = value;
  }
};
