import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/browser";

/** Both runtimes hash the validated request UUID before correlating events. */
export const resourceMutationDigest = async (
  mutationId: string,
): Promise<string> => {
  const id = v.parse(v.pipe(v.string(), v.uuid()), mutationId);
  return await sha256Hex(id);
};
