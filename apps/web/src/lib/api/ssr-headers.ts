import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

// Forward only the browser's cookies to the configured first-party API.
// Never retain credentials in a module or forward arbitrary proxy headers.
export const ssrApiHeaders = createIsomorphicFn()
  .server(() => {
    const cookie = getRequestHeader("cookie");
    return cookie === undefined ? {} : { cookie };
  })
  .client(() => ({}));
