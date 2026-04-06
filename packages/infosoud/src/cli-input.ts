import { parseSpisZn, splitSpisZnAndCourtQuery } from "./spis-zn.js";
import type { SpisZn } from "./types.js";

export type ResolvedCliLookupInput = {
  readonly courtReference?: string | undefined;
  readonly parsedSpisZn: SpisZn;
};

export const resolveCliLookupInput = ({
  courtArg,
  spisInput,
}: {
  readonly courtArg?: string | undefined;
  readonly spisInput: string;
}): ResolvedCliLookupInput => {
  const splitInput = splitSpisZnAndCourtQuery(spisInput);
  const parsedSpisZn = parseSpisZn(
    splitInput.courtQuery ? splitInput.spisZn : spisInput,
  );

  return {
    courtReference: courtArg ?? splitInput.courtQuery ?? parsedSpisZn.courtCode,
    parsedSpisZn,
  };
};
