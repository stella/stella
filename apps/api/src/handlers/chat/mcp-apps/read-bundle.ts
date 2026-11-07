import { Result } from "better-result";
import * as v from "valibot";

import type { StellaMcpAppBundle } from "@stll/api-contract/stella-mcp-app";
import { readMcpAppBundle } from "@stll/mcp-apps/bundles";

import { chatMcpAppByDirectory } from "@/api/handlers/chat/mcp-apps/catalog";
import type { CachePolicy } from "@/api/http/cache";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * The document is the same for every member and changes only with a deploy;
 * a browser keeps it for a few minutes so a thread of apps loads it once.
 */
const BUNDLE_CACHE = {
  kind: "private",
  maxAge: 300,
} as const satisfies CachePolicy;

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  // A bundle name, read from a stored part's resource; one no chat app owns
  // is not found.
  params: v.object({
    app: v.pipe(
      v.string(),
      v.maxLength(64),
      v.regex(/^[a-z][a-z0-9-]{0,63}$/u),
    ),
  }),
} satisfies HandlerConfig;

/**
 * One stella app's document, for the chat frame that shows it. It is served
 * as JSON data, never as a page of this origin: the browser hands the text to
 * the sandboxed frame, which is the only place it runs. It reads no tenant
 * data, so the member's session is the whole of its authorization.
 */
const readChatMcpAppBundle = createSafeRootHandler(
  config,
  // oxlint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* ({ params, set }) {
    const app = chatMcpAppByDirectory(params.app);
    if (app === undefined) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "App not found",
        }),
      );
    }
    set.headers["X-Content-Type-Options"] = "nosniff";
    set.cache = BUNDLE_CACHE;
    return Result.ok({
      uri: app.uri,
      html: readMcpAppBundle(app.directory),
    } satisfies StellaMcpAppBundle);
  },
);

export default readChatMcpAppBundle;
