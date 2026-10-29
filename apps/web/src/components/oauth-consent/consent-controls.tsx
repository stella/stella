import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  OAuthAccountList,
  OAuthAccountRow,
} from "@/components/oauth-consent/oauth-account";

type ConsentAccountRowsProps = {
  activeOrganizationId: string | null;
  disabled: boolean;
  email: string;
  onAccountSwitch: () => void;
  onOrganizationSwitch: (organizationId: string) => void;
  organizationName: string | null;
  organizations: readonly { id: string; name: string }[] | undefined;
};

/** Who is granting access, and in which organization the app will work. */
export const ConsentAccountRows = ({
  activeOrganizationId,
  disabled,
  email,
  onAccountSwitch,
  onOrganizationSwitch,
  organizationName,
  organizations,
}: ConsentAccountRowsProps) => {
  const tCommon = useTranslations("common");
  const tOrganization = useTranslations("organization");
  return (
    <OAuthAccountList>
      <OAuthAccountRow
        disabled={disabled}
        email={email}
        onAccountSwitch={onAccountSwitch}
      />
      {organizationName ? (
        <>
          <dt className="text-muted-foreground">{tCommon("organization")}</dt>
          <dd className="min-w-0">
            {organizations !== undefined && organizations.length > 1 ? (
              <Select
                disabled={disabled}
                onValueChange={(organizationId) => {
                  if (
                    typeof organizationId === "string" &&
                    organizationId !== activeOrganizationId
                  ) {
                    onOrganizationSwitch(organizationId);
                  }
                }}
                value={activeOrganizationId}
              >
                <SelectTrigger
                  aria-label={tOrganization("switchOrganization")}
                  className="min-h-11 w-full"
                >
                  <SelectValue>{() => organizationName}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.id}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <p className="flex min-h-11 items-center">{organizationName}</p>
            )}
          </dd>
        </>
      ) : null}
    </OAuthAccountList>
  );
};

/** Decline and Allow, outside the scrolling body so they never leave view. */
export const ConsentDecisionBar = ({
  allowDisabled,
  hasError,
  isPending,
  onDecide,
}: {
  allowDisabled: boolean;
  hasError: boolean;
  isPending: boolean;
  onDecide: (accept: boolean) => void;
}) => {
  const t = useTranslations("consent");
  const tCommon = useTranslations("common");
  return (
    <div
      className="border-border/64 bg-background flex shrink-0 flex-col gap-2 border-t px-6 py-4"
      data-slot="consent-decision-bar"
    >
      {hasError ? (
        <p className="text-destructive text-sm">{t("error")}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Button
          className="min-h-11 w-full"
          disabled={isPending}
          onClick={() => {
            onDecide(false);
          }}
          type="button"
          variant="outline"
        >
          {tCommon("decline")}
        </Button>
        <Button
          className="min-h-11 w-full"
          disabled={isPending || allowDisabled}
          loading={isPending}
          onClick={() => {
            onDecide(true);
          }}
          type="button"
        >
          {t("allow")}
        </Button>
      </div>
    </div>
  );
};
