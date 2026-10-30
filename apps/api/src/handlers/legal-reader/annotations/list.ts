import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  listAnnotationsQuerySchema,
  listReaderAnnotationsHandler,
} from "@/api/lib/legal-search/reader-annotations/list";

const config = {
  contract: "patch",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  description:
    "List the highlights and comments on one decision or statute version: the caller's own and those colleagues shared.",
  mcp: { type: "tool", name: "list_reader_annotations" },
  access: "read",
  query: listAnnotationsQuerySchema,
} satisfies HandlerConfig;

type ReadDependencies = Pick<
  Parameters<typeof listReaderAnnotationsHandler>[0],
  "readCopies"
>;

export const createListReaderAnnotations = ({
  readCopies,
}: ReadDependencies = {}) =>
  createSafeRootHandler(
    config,
    async function* ({ query, safeDb, session, user: me }) {
      return yield* listReaderAnnotationsHandler({
        organizationId: session.activeOrganizationId,
        query,
        safeDb,
        readCopies,
        userId: me.id,
      });
    },
  );

export default createListReaderAnnotations();
