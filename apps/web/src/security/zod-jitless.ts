import { config } from "zod/v4/core";

// The content security policy blocks string evaluation. zod's JIT object
// parser probes `new Function` when its first object schema is built (the
// chat runtime builds them on import); under the policy that probe fails and
// zod falls back to its interpreted parser, but the browser still reports a
// policy violation. Selecting the interpreted parser up front keeps the same
// parse behaviour without the probe. Call it before any schema is built.
export const runZodWithoutEval = (): void => {
  config({ jitless: true });
};
