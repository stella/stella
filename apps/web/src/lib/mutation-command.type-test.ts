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

type Expect<Condition extends true> = Condition;

export type EmptyPatchIsRejected = Expect<
  Record<never, never> extends NonEmptyPatch<ExamplePatchFields> ? false : true
>;
