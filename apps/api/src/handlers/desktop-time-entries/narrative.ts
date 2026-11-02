import { Result } from "better-result";

import {
  desktopTimeEntryNarrativeRequestSchema,
  desktopTimeEntryNarrativeResponseSchema,
} from "@stll/api-contract/desktop-time-entries";

import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";

import { authorizeDesktopTimeEntries } from "./authorize";
import { type AdmitDrafting, DraftingAdmission } from "./drafting-model";
import {
  type DesktopTimeEntryNarrativeRun,
  runDesktopTimeEntryNarrative,
} from "./narrative-model";

type DesktopTimeEntryNarrativeDependencies = {
  authorizeAccount?: typeof authorizeDesktopAccount;
  admitDrafting?: AdmitDrafting;
  narrate?: DesktopTimeEntryNarrativeRun;
};

export const createDesktopTimeEntryNarrativeEndpoint = ({
  authorizeAccount = authorizeDesktopAccount,
  admitDrafting = async (account) => await DraftingAdmission.admit(account),
  narrate = runDesktopTimeEntryNarrative,
}: DesktopTimeEntryNarrativeDependencies = {}) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "billing_ui" },
      cache: { kind: "none" },
      body: desktopTimeEntryNarrativeRequestSchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopTimeEntryNarrativeResponseSchema,
      ),
    },
    async function* ({ request, body }) {
      const account = yield* Result.await(
        authorizeDesktopTimeEntries(request, authorizeAccount),
      );
      if (!hasMemberPermission(account.memberRole, { timeEntry: ["create"] })) {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Time entry creation is not permitted",
          }),
        );
      }
      // Window titles are privileged activity: the organization's switch and
      // the member's consent stop the request here, and the model call reads
      // them again before every provider request.
      const drafting = yield* Result.await(admitDrafting(account));
      const narrative = yield* Result.await(
        narrate({ account, drafting, request: body, signal: request.signal }),
      );
      return Result.ok({ narrative });
    },
  );

const desktopTimeEntryNarrativeEndpoint =
  createDesktopTimeEntryNarrativeEndpoint();

declareAggregateMutation(desktopTimeEntryNarrativeEndpoint, {
  type: "independent",
  reason:
    "Writes a narrative from client-supplied titles and returns it; it reads no aggregate and stores neither the titles nor the narrative.",
});

export default desktopTimeEntryNarrativeEndpoint;
