import { Result } from "better-result";
import * as v from "valibot";

import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readServedSoftLaw } from "@/api/lib/legal-search/soft-law-read";
import { softLawSurfaceOfRoute } from "@/api/lib/legal-search/soft-law-serving";

import { readSoftLawResponseSchema } from "./read-schema";

const config = {
  contract: "patch",
  description:
    "Read one served regulator guidance document by id: its issuer, kind, reference, " +
    "issue date, validity as the publisher states it, publisher URL, required attribution " +
    "and text. It is guidance, not a court decision. textState says why text is null: " +
    "withheld_by_source_setting or not_extracted. A source that is not served answers not found. " +
    "When you summarize this text, show attribution.text, its conditions and any summaryDisclaimer with the summary.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "tool", name: "read_guidance" },
  access: "read",
  params: v.object({ documentId: resourceIdSchema("softLawDocument") }),
  response: readSoftLawResponseSchema,
} satisfies HandlerConfig;

const readSoftLaw = createSafeRootHandler(
  config,
  async function* ({ params: { documentId }, route }) {
    const document = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readServedSoftLaw({
            documentId,
            surface: softLawSurfaceOfRoute(route),
          }),
      ),
    );
    return Result.ok(
      document ?? status(404, { message: "Guidance document not found" }),
    );
  },
);

export default readSoftLaw;
