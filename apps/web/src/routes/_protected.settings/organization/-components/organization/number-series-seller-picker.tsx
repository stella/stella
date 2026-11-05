import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import {
  sellerProfileOptions,
  sellerProfilesOptions,
} from "@/lib/organization/seller-profiles";

import { sellerSelection } from "./number-series-seller-picker.logic";

const ALL_SELLERS = "all-sellers";

export const NumberSeriesSellerPicker = ({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  id: string;
  disabled: boolean;
}) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const query = useInfiniteQuery(
    sellerProfilesOptions(user.activeOrganizationId),
  );
  const profiles =
    query.data === undefined
      ? []
      : query.data.pages.flatMap((page) => page.items);
  const selectedInList = profiles.find((profile) => profile.id === value);
  const selected = useQuery({
    ...sellerProfileOptions({
      organizationId: user.activeOrganizationId,
      id: value ?? "",
    }),
    enabled: value !== null && selectedInList === undefined,
  });
  const selection = sellerSelection({
    value,
    profileName: selectedInList?.legalName ?? selected.data?.legalName,
    error: selectedInList === undefined ? selected.error : null,
  });
  const selectedLabel = (() => {
    switch (selection.type) {
      case "all":
        return t("billing.numberSeries.allSellers");
      case "profile":
        return <BidiText>{selection.name}</BidiText>;
      case "loading":
        return t("common.loading");
      case "unavailable":
        return t("billing.numberSeries.sellerUnavailable");
      case "error":
        return t("errors.actionFailed");
      default:
        selection satisfies never;
        return panic("Unexpected seller selection");
    }
  })();
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={value ?? ALL_SELLERS}
        onValueChange={(next) => {
          if (next === null) {
            return;
          }
          onChange(next === ALL_SELLERS ? null : next);
        }}
        disabled={disabled || query.isPending}
      >
        <SelectTrigger id={id}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={ALL_SELLERS}>
            {t("billing.numberSeries.allSellers")}
          </SelectItem>
          {value !== null && selectedInList === undefined && (
            <SelectItem value={value} disabled>
              {selectedLabel}
            </SelectItem>
          )}
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>
              <BidiText>{profile.legalName}</BidiText>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {selection.type === "unavailable" && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("billing.numberSeries.sellerUnavailableHelp")}
        </p>
      )}
      {selection.type === "error" && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-destructive text-sm">
            {t("errors.actionFailed")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || selected.isFetching}
            onClick={() =>
              detached(selected.refetch(), "number-series.seller-retry")
            }
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {query.error !== null && (
        <div className="flex items-center justify-between gap-2">
          <p role="alert" className="text-destructive text-sm">
            {t("errors.actionFailed")}
          </p>
          <Button
            type="button"
            disabled={disabled || query.isFetching}
            variant="outline"
            size="sm"
            onClick={() =>
              detached(query.refetch(), "number-series.sellers-retry")
            }
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || query.isFetchingNextPage}
          onClick={() =>
            detached(query.fetchNextPage(), "number-series.sellers-more")
          }
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};
