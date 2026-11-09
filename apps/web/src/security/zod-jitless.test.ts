import { expect, test } from "bun:test";
// oxlint-disable-next-line no-restricted-imports -- exercises zod's own parser, which the chat runtime loads through @tanstack/ai; app schemas stay on valibot
import { z } from "zod";

import { runZodWithoutEval } from "./zod-jitless";

test("object schemas build and parse without evaluating strings", () => {
  const original = globalThis.Function;
  const evaluated: unknown[][] = [];
  globalThis.Function = new Proxy(original, {
    apply: (target, thisArgument, argumentsList: unknown[]) => {
      evaluated.push(argumentsList);
      return Reflect.apply(target, thisArgument, argumentsList);
    },
    construct: (target, argumentsList: unknown[]) => {
      evaluated.push(argumentsList);
      return Reflect.construct(target, argumentsList);
    },
  });
  try {
    runZodWithoutEval();
    const schema = z.object({
      name: z.string(),
      tags: z.array(z.object({ id: z.number() })),
    });
    expect(schema.parse({ name: "brief", tags: [{ id: 1 }] })).toEqual({
      name: "brief",
      tags: [{ id: 1 }],
    });
    expect(schema.safeParse({ name: 1, tags: [] }).success).toBe(false);
  } finally {
    globalThis.Function = original;
  }
  expect(evaluated).toEqual([]);
});
