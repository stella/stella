/**
 * index.html's boot module: sends the session/role prefetch while the main
 * application graph is still downloading. The prefetch lives in
 * `boot-prefetch.ts`, which the main graph shares through the auth client, so
 * the request fires only from this entry and never as a side effect of
 * importing the auth client.
 */
import { startBootPrefetch } from "@/boot-prefetch";

startBootPrefetch();
