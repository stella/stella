import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";
import { Button } from "@stll/ui/button";
import { SparklesIcon, XIcon } from "@stll/ui/icons";

import { InviteMemberDialog } from "@/components/organization/invite-member-dialog";
import { useUserStorageState } from "@/lib/account/use-user-storage-state";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import {
  decodeSetupPending,
  encodeSetupPending,
  ORGANIZATION_SETUP_PENDING_KEY,
} from "@/lib/organization/setup-pending";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * On the empty chat of an organization the user just created: invite
 * members, and optionally set up AI, with what happens without keys. It
 * stays until closed; nothing else of the page waits on it.
 */
export const OrganizationSetupNudge = () => {
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();
  const { value: pending, updateValue } = useUserStorageState({
    baseKey: ORGANIZATION_SETUP_PENDING_KEY,
    area: "local",
    decode: decodeSetupPending,
    encode: encodeSetupPending,
  });
  const availabilityView = queryView(
    useQuery(aiAvailabilityOptions({ organizationId: activeOrganizationId })),
  );
  useQueryViewError(availabilityView, "OrganizationSetupNudge:availability");

  if (!pending.includes(activeOrganizationId)) {
    return null;
  }

  return (
    <section
      aria-labelledby="organization-setup-title"
      className="bg-background flex flex-col gap-3 rounded-lg border p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-medium" id="organization-setup-title">
          {t("organizationSetup.title")}
        </h2>
        <Button
          aria-label={t("common.dismiss")}
          className="-me-2 -mt-2"
          onClick={() =>
            updateValue((previous) =>
              previous.filter((id) => id !== activeOrganizationId),
            )
          }
          size="icon-sm"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground min-w-0 flex-1">
          {t("organizationSetup.invite")}
        </p>
        <InviteMemberDialog />
      </div>
      {availabilityView.type === "items" && (
        <AISetupLine availability={availabilityView.items} />
      )}
    </section>
  );
};

/**
 * Whether keys are optional here and where to add them; only for someone
 * who may configure the provider, and only once that is known.
 */
const AISetupLine = ({
  availability,
}: {
  availability: OrganizationAIAvailability;
}) => {
  const t = useTranslations();
  const message = aiSetupMessage(availability);
  if (availability.providerConfiguration !== "allowed" || message === null) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground min-w-0 flex-1">{t(message)}</p>
      <Button
        render={<Link to="/settings/organization/ai" />}
        size="sm"
        variant="outline"
      >
        <SparklesIcon className="size-4" />
        {t("organizationSetup.aiAction")}
      </Button>
    </div>
  );
};

const aiSetupMessage = (availability: OrganizationAIAvailability) => {
  // Once the organization has its own keys, availability no longer says
  // whether AI would work without them, and the step is done.
  if (availability.orgConfigured) {
    return null;
  }
  if (availability.available) {
    return "organizationSetup.aiOptional" as const;
  }
  switch (availability.unavailableReason) {
    case "own_key_required":
    case "provider_not_configured":
      return "organizationSetup.aiRequired" as const;
    case "member_assignment_required":
    case "unreadable":
    case null:
      return null;
    default:
      availability.unavailableReason satisfies never;
      return panic("Unhandled AI unavailable reason");
  }
};
