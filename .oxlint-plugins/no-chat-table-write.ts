// Chat tools write rows through the shared write primitives in
// `apps/api/src/lib` (`writeFieldValue`, `createEntityFromBuffer`,
// `createEntityVersionFromBuffer`, `persistExplicitMemory`, ...), which own
// the access checks, locks and audit events for each write. A chat tool that
// writes a table itself would hold a second copy of those rules, so any
// database write in `apps/api/src/handlers/chat/tools/**` is reported.
//
// Detection is `isDatabaseWriteCall` from utils.ts, shared with
// `require-audit-on-mutation`: a Drizzle `.insert(`, `.update(` or `.delete(`
// on a database handle, or an `.execute(sql`...`)` whose static SQL writes
// rows. Reads and calls into lib primitives are not writes.
//
// The scope (chat tools, tests excluded) lives in `oxlint.config.ts`.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { isDatabaseWriteCall } from "./utils.ts";

export default eslintCompatPlugin({
  meta: { name: "no-chat-table-write" },
  rules: {
    "no-chat-table-write": {
      meta: {
        type: "problem",
        messages: {
          chatTableWrite:
            "Chat tools do not write tables directly. Call the shared " +
            "write primitive in apps/api/src/lib that owns this write " +
            "(e.g. writeFieldValue, createEntityFromBuffer, " +
            "createEntityVersionFromBuffer, persistExplicitMemory), or add " +
            "one there.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (isDatabaseWriteCall(context, node)) {
              context.report({ node, messageId: "chatTableWrite" });
            }
          },
        };
      },
    },
  },
});
