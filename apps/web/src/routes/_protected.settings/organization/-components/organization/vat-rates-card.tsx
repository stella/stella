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

import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import {
  sendVatRateCommand,
  vatRatesKeys,
  vatRatesOptions,
} from "@/lib/organization/vat-rates";
import type {
  VatRate,
  VatRateCommand,
  VatRateInput,
} from "@/lib/organization/vat-rates";
import {
  VAT_RATE_COLUMNS,
  VatRatesCardShell,
} from "@/routes/_protected.settings/-organization.vat-rates.pending";
import {
  VatRateDate,
  VatRatePercentage,
  VatRateRefusal,
  vatRateStatus,
} from "@/routes/_protected.settings/organization/-components/organization/vat-rate-display";
import { VatRateForm } from "@/routes/_protected.settings/organization/-components/organization/vat-rate-form";
import { presetResultWhenCommandStarts } from "@/routes/_protected.settings/organization/-components/organization/vat-rates-card.logic";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

import {
  BillingSettingsRow,
  BillingSettingsTable,
} from "./billing-settings-table.pending";

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
  const [presetResult, setPresetResult] = useState<{
    added: number;
    skipped: number;
  } | null>(null);
  const mutation = useSettingsMutation({
    exceptionScope: (command) => ({
      type: "handler",
      handlerId: `settings.vat-rate.${command.type}`,
    }),
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
    setPresetResult((current) =>
      presetResultWhenCommandStarts(command, current),
    );
    const result = await Result.tryPromise(async () =>
      mutation.mutateAsync(command),
    );
    if (Result.isOk(result)) {
      if (command.type === "applyPreset" && "added" in result.value) {
        setPresetResult(result.value);
      }
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
    <VatRatesCardShell
      actions={
        <>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            disabledReason={t("common.saving")}
            onClick={() =>
              detached(
                run({ type: "applyPreset", country: "SK" }),
                "vat-rates.preset-sk",
              )
            }
          >
            {t("billing.vatRates.addSlovakia")}
          </Button>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            disabledReason={t("common.saving")}
            onClick={() =>
              detached(
                run({ type: "applyPreset", country: "CZ" }),
                "vat-rates.preset-cz",
              )
            }
          >
            {t("billing.vatRates.addCzechia")}
          </Button>
          <Button
            onClick={() => open({ type: "create" })}
            disabled={mutation.isPending}
            disabledReason={t("common.saving")}
          >
            {t("billing.vatRates.add")}
          </Button>
        </>
      }
    >
      {presetResult !== null && (
        <p className="text-muted-foreground text-sm" role="status">
          {t("billing.vatRates.presetResult", {
            added: String(presetResult.added),
            skipped: String(presetResult.skipped),
          })}
        </p>
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
      {(query.isPending || rates.length > 0) && (
        <BillingSettingsTable
          columns={VAT_RATE_COLUMNS}
          rows={
            query.isPending
              ? { type: "pending", rowClassName: "max-sm:h-30" }
              : {
                  type: "loaded",
                  children: rates.map((rate) => (
                    <BillingSettingsRow
                      key={rate.id}
                      columns={VAT_RATE_COLUMNS}
                      cells={{
                        code: <BidiText>{rate.code}</BidiText>,
                        name: (
                          <>
                            <BidiText>{rate.name}</BidiText>
                            <p className="text-muted-foreground text-xs">
                              {t(
                                statusLabels[
                                  vatRateStatus({ rate, date: today })
                                ],
                              )}
                            </p>
                            {/* Narrow screens show the secondary columns' values
                              here so the actions column fits on screen. */}
                            <DetailsGrid className="mt-1 sm:hidden">
                              <DetailsItem label={t("billing.vatRates.code")}>
                                <BidiText>{rate.code}</BidiText>
                              </DetailsItem>
                              <DetailsItem
                                label={t("billing.vatRates.validFrom")}
                              >
                                <VatRateDate date={rate.validFrom} />
                              </DetailsItem>
                              <DetailsItem
                                label={t("billing.vatRates.validTo")}
                              >
                                <VatRateDate date={rate.validTo} />
                              </DetailsItem>
                            </DetailsGrid>
                          </>
                        ),
                        rate: <VatRatePercentage rateBps={rate.rateBps} />,
                        from: <VatRateDate date={rate.validFrom} />,
                        to: <VatRateDate date={rate.validTo} />,
                        actions: (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={mutation.isPending}
                              disabledReason={t("common.saving")}
                              onClick={() => open({ type: "edit", rate })}
                            >
                              {t("common.edit")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={mutation.isPending}
                              disabledReason={t("common.archiving")}
                              onClick={() => open({ type: "archive", rate })}
                            >
                              {t("common.archive")}
                            </Button>
                          </div>
                        ),
                      }}
                    />
                  )),
                }
          }
        />
      )}
      {query.hasNextPage && (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          disabledReason={t("common.loading")}
          onClick={() => detached(query.fetchNextPage(), "vat-rates.load-more")}
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
                    disabledReason={t("common.archiving")}
                    onClick={close}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={mutation.isPending}
                    disabledReason={t("common.saving")}
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
    </VatRatesCardShell>
  );
};
