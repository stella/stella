import { lazy, Suspense } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useRequireAccount } from "@/components/auth/use-require-account";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { catalogueTemplateHref } from "@/lib/knowledge/catalogue-intent";
import type { TemplateIntent } from "@/lib/knowledge/catalogue-intent";

// The member's actions write to the organization's library; their chunk loads
// only once the visitor is known to be a member.
const LazyMemberCatalogueTemplateActions = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-catalogue-template-actions");
  return { default: module.MemberCatalogueTemplateActions };
});

type CatalogueTemplateActionsProps = {
  packId: string;
  templateSlug: string;
  templateName: string;
  intent: TemplateIntent | undefined;
  onIntentSettled: () => void;
};

/**
 * What a catalogue template page offers, by who is visiting: nothing to press
 * while the session is read, the account gate for a visitor (coming back to
 * this page with the act named), and the member's own actions otherwise.
 */
export const CatalogueTemplateActions = ({
  packId,
  templateSlug,
  templateName,
  intent,
  onIntentSettled,
}: CatalogueTemplateActionsProps) => {
  const authStatus = useClientAuthStatus();
  const ensureAccount = useRequireAccount();

  if (authStatus.status === "authenticated") {
    return (
      <Suspense
        fallback={<GatedButtons disabled onRequest={() => undefined} />}
      >
        <LazyMemberCatalogueTemplateActions
          intent={intent}
          key={authStatus.user.activeOrganizationId}
          onIntentSettled={onIntentSettled}
          organizationId={authStatus.user.activeOrganizationId}
          packId={packId}
          templateName={templateName}
          templateSlug={templateSlug}
        />
      </Suspense>
    );
  }

  return (
    <GatedButtons
      disabled={authStatus.status === "checking"}
      onRequest={(act) => {
        ensureAccount({
          returnTo: catalogueTemplateHref(packId, templateSlug, act),
        });
      }}
    />
  );
};

const GatedButtons = ({
  disabled,
  onRequest,
}: {
  disabled: boolean;
  onRequest: (act: TemplateIntent) => void;
}) => {
  const t = useTranslations();
  return (
    <>
      <Button disabled={disabled} onClick={() => onRequest("use")} size="sm">
        {t("templates.useTemplate")}
      </Button>
      <Button
        disabled={disabled}
        onClick={() => onRequest("add")}
        size="sm"
        variant="outline"
      >
        {t("knowledge.catalogue.addToLibrary")}
      </Button>
      <Button
        disabled={disabled}
        onClick={() => onRequest("download")}
        size="sm"
        variant="outline"
      >
        {t("common.download")}
      </Button>
    </>
  );
};
