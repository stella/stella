import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Frame, FramePanel } from "@stll/ui/frame";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import {
  vatRatesKeys,
  vatRatesOptions,
  sendVatRateCommand,
} from "@/lib/organization/vat-rates";
import type {
  VatRate,
  VatRateCommand,
  VatRateInput,
} from "@/lib/organization/vat-rates";
import {
  VatRatePercentage,
  VatRateDate,
  vatRateStatus,
  VatRateRefusal,
} from "@/routes/_protected.settings/-components/organization/vat-rate-display";
import { VatRateForm } from "@/routes/_protected.settings/-components/organization/vat-rate-form";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

type RateDialog =
  | { type: "closed" }
  | { type: "create" }
  | { type: "edit"; rate: VatRate }
  | { type: "archive"; rate: VatRate };

export const VatRatesCard = () => {
  const preview = useTimeBillingPreviewEnabled();
  const canUpdate = usePermissions({ organizationSettings: ["update"] });
  const user = useAuthenticatedUser();
  if (!preview || !canUpdate) {
    return null;
  }
  return (
    <VatRatesCardBody
      key={user.activeOrganizationId}
      organizationId={user.activeOrganizationId}
    />
  );
};

const VatRatesCardBody = ({ organizationId }: { organizationId: string }) => {
  const t = useTranslations();
  const query = useInfiniteQuery(vatRatesOptions(organizationId));
  const [dialog, setDialog] = useState<RateDialog>({ type: "closed" });
  const mutation = useSettingsMutation({
    mutationFn: sendVatRateCommand,
    invalidate: vatRatesKeys.all(organizationId),
  });
  const rates =
    query.data === undefined
      ? []
      : query.data.pages.flatMap((page) => page.items);
  const today = localISODate();
  const statusLabels = {
    current: "billing.vatRates.current",
    future: "billing.vatRates.future",
    past: "billing.vatRates.past",
  } as const;
  const close = () => {
    if (!mutation.isPending) {
      setDialog({ type: "closed" });
      mutation.reset();
    }
  };
  const run = async (command: VatRateCommand) => {
    if (mutation.isPending) {
      return;
    }
    const result = await Result.tryPromise(async () =>
      mutation.mutateAsync(command),
    );
    if (Result.isOk(result)) {
      setDialog({ type: "closed" });
      mutation.reset();
    }
  };
  const save = async (values: VatRateInput) => {
    switch (dialog.type) {
      case "create":
        await run({ type: "create", values });
        return;
      case "edit":
        await run({ type: "update", id: dialog.rate.id, values });
        return;
      case "closed":
      case "archive":
        return;
    }
  };
  const open = (next: RateDialog) => {
    mutation.reset();
    setDialog(next);
  };

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-sm">
              {t("billing.vatRates.description")}
            </p>
          </div>
          <Button
            onClick={() => open({ type: "create" })}
            disabled={mutation.isPending}
          >
            {t("billing.vatRates.add")}
          </Button>
        </div>
        {query.isPending && (
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        )}
        {query.error !== null && (
          <div className="flex items-center justify-between gap-2">
            <VatRateRefusal error={query.error} />
            <Button
              variant="outline"
              onClick={() => detached(query.refetch(), "vat-rates.retry")}
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {mutation.error !== null && dialog.type === "closed" && (
          <VatRateRefusal error={mutation.error} />
        )}
        {query.isSuccess && rates.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("billing.vatRates.empty")}
          </p>
        )}
        {rates.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="max-sm:hidden">
                  {t("billing.vatRates.code")}
                </TableHead>
                <TableHead>{t("billing.vatRates.name")}</TableHead>
                <TableHead>{t("billing.vatRates.rate")}</TableHead>
                <TableHead className="max-sm:hidden">
                  {t("billing.vatRates.validFrom")}
                </TableHead>
                <TableHead className="max-sm:hidden">
                  {t("billing.vatRates.validTo")}
                </TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.map((rate) => (
                <TableRow key={rate.id}>
                  <TableCell className="max-sm:hidden">
                    <BidiText>{rate.code}</BidiText>
                  </TableCell>
                  <TableCell>
                    <BidiText>{rate.name}</BidiText>
                    <p className="text-muted-foreground text-xs">
                      {t(statusLabels[vatRateStatus({ rate, date: today })])}
                    </p>
                    {/* Narrow screens hide the secondary columns; their values
                    stay readable here so the actions column fits on screen. */}
                    <DetailsGrid className="mt-1 sm:hidden">
                      <DetailsItem label={t("billing.vatRates.code")}>
                        <BidiText>{rate.code}</BidiText>
                      </DetailsItem>
                      <DetailsItem label={t("billing.vatRates.validFrom")}>
                        <VatRateDate date={rate.validFrom} />
                      </DetailsItem>
                      <DetailsItem label={t("billing.vatRates.validTo")}>
                        <VatRateDate date={rate.validTo} />
                      </DetailsItem>
                    </DetailsGrid>
                  </TableCell>
                  <TableCell>
                    <VatRatePercentage rateBps={rate.rateBps} />
                  </TableCell>
                  <TableCell className="max-sm:hidden">
                    <VatRateDate date={rate.validFrom} />
                  </TableCell>
                  <TableCell className="max-sm:hidden">
                    <VatRateDate date={rate.validTo} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => open({ type: "edit", rate })}
                      >
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => open({ type: "archive", rate })}
                      >
                        {t("common.archive")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {query.hasNextPage && (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() =>
              detached(query.fetchNextPage(), "vat-rates.load-more")
            }
          >
            {t("common.loadMore")}
          </Button>
        )}
        <Dialog
          open={dialog.type !== "closed"}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              close();
            }
          }}
        >
          {dialog.type !== "closed" && (
            <DialogPopup className="max-w-xl">
              <DialogHeader>
                <DialogTitle>
                  {dialog.type === "create" && t("billing.vatRates.add")}
                  {dialog.type === "archive" && t("common.archive")}
                  {dialog.type === "edit" && t("billing.vatRates.edit")}
                </DialogTitle>
              </DialogHeader>
              {mutation.error !== null && (
                <DialogPanel>
                  <VatRateRefusal error={mutation.error} />
                </DialogPanel>
              )}
              {dialog.type === "archive" ? (
                <>
                  <DialogPanel className="flex flex-col gap-4">
                    <p className="text-sm">
                      {t("billing.vatRates.archiveConfirm")}
                    </p>
                    <BidiText>{dialog.rate.name}</BidiText>
                  </DialogPanel>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={close}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={mutation.isPending}
                      onClick={() =>
                        detached(
                          run({ type: "archive", id: dialog.rate.id }),
                          "vat-rates.archive",
                        )
                      }
                    >
                      {t("common.archive")}
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <VatRateForm
                  key={dialog.type === "edit" ? dialog.rate.id : "new"}
                  {...(dialog.type === "edit" ? { rate: dialog.rate } : {})}
                  pending={mutation.isPending}
                  onCancel={close}
                  onSubmit={save}
                />
              )}
            </DialogPopup>
          )}
        </Dialog>
      </FramePanel>
    </Frame>
  );
};
