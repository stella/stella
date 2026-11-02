import { createIsomorphicFn } from "@tanstack/react-start";

import { getRequestNonce } from "./content-security-policy.server";

// Router captures this value when attaching its stream/dehydration utilities.
export const getRequestSsrOptions = createIsomorphicFn()
  .server(() => ({ nonce: getRequestNonce() }))
  .client(() => ({}));
