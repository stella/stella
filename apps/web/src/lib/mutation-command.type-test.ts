import { expectTypeOf } from "bun:test";

import type { NonEmptyPatch } from "@/lib/mutation-command";

type ExamplePatchFields = {
  color: string;
  name: string;
};

export const singleFieldPatch: NonEmptyPatch<ExamplePatchFields> = {
  color: "blue",
};

export const multiFieldPatch: NonEmptyPatch<ExamplePatchFields> = {
  color: "blue",
  name: "Appeal",
};

// An empty patch is rejected.
expectTypeOf<Record<never, never>>().not.toExtend<
  NonEmptyPatch<ExamplePatchFields>
>();
