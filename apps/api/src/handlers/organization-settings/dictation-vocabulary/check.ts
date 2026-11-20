import { Result } from "better-result";

import { dictationTermKey } from "@stll/api-contract/dictation-vocabulary";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import {
  countOrganizationTerms,
  dictationTermsBodySchema,
  listedTermKeys,
} from "./terms";

const config = {
  contract: "patch",
  description:
    "Check words before adding them to the organization's dictation list: " +
    "how many the list already holds (in any case) and how many words it " +
    "holds now. Nothing is stored.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "organization_admin",
    consumesServices: false,
  },
  body: dictationTermsBodySchema,
} satisfies HandlerConfig;

const checkDictationVocabulary = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session }) {
    const organizationId = session.activeOrganizationId;
    const checked = yield* Result.await(
      safeDb(async (tx) => ({
        listed: await listedTermKeys(
          tx,
          organizationId,
          body.terms.map(dictationTermKey),
        ),
        total: await countOrganizationTerms(tx, organizationId),
      })),
    );
    return Result.ok({ listed: checked.listed.size, total: checked.total });
  },
);

export default checkDictationVocabulary;
