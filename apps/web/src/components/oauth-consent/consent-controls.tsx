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
  ConsentActingAsLine,
  ConsentActingAsPending,
  ConsentDecisionBarFace,
  ConsentOrganizationPending,
  ConsentOrganizationRow,
  ConsentOrganizationValue,
  OAuthAccountList,
} from "@/components/oauth-consent/consent-control-faces.pending";
import { OAuthAccountRow } from "@/components/oauth-consent/oauth-account";

type ConsentAccountRowsProps = {
  activeOrganizationId: string | null;
  disabled: boolean;
  email: string;
  onAccountSwitch: () => void;
  onOrganizationSwitch: (organizationId: string) => void;
  organizationName: string | null;
  organizationsPending?: boolean;
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
  organizationsPending = false,
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
        <ConsentOrganizationRow label={tCommon("organization")}>
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
            <ConsentOrganizationValue>
              {organizationName}
            </ConsentOrganizationValue>
          )}
        </ConsentOrganizationRow>
      ) : (
        organizationsPending &&
        activeOrganizationId !== null && <ConsentOrganizationPending />
      )}
    </OAuthAccountList>
  );
};

export const ConsentActingAs = ({
  organizationName,
  pending,
  clientName,
}: {
  organizationName: string | null;
  pending: boolean;
  clientName: string;
}) => {
  const t = useTranslations("consent");
  if (organizationName === null) {
    return pending ? <ConsentActingAsPending /> : null;
  }
  return (
    <ConsentActingAsLine>
      {t("actingAs", { clientName, organizationName })}
    </ConsentActingAsLine>
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
    <ConsentDecisionBarFace
      error={
        hasError ? (
          <p className="text-destructive text-sm">{t("error")}</p>
        ) : null
      }
      decline={
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
      }
      allow={
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
      }
    />
  );
};
