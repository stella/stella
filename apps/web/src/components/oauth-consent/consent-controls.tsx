import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

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
  const t = useTranslations("consent");
  const tCommon = useTranslations("common");
  const tAccount = useTranslations("settings.account");
  const tOrganization = useTranslations("organization");
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground self-start sm:self-center">
        {tAccount("title")}
      </dt>
      <dd className="flex min-w-0 flex-col items-start gap-x-3 sm:flex-row sm:items-center sm:justify-between">
        <bdi className="min-w-0 break-all">{email}</bdi>
        <Button
          variant="link"
          size="xs"
          className="-ms-2 min-h-11 self-start sm:ms-0 sm:self-auto"
          disabled={disabled}
          onClick={onAccountSwitch}
        >
          {t("useAnotherAccount")}
        </Button>
      </dd>
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
    </dl>
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
    <div className="border-border/64 bg-background flex shrink-0 flex-col gap-2 border-t px-6 py-4">
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
