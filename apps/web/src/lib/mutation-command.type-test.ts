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

// @ts-expect-error -- an intentional PATCH must supply at least one field
export const emptyPatch: NonEmptyPatch<ExamplePatchFields> = {};
