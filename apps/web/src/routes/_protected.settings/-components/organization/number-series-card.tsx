import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import {
  numberSeriesKeys,
  numberSeriesOptions,
  sendNumberSeriesCommand,
} from "@/lib/organization/number-series";
import type {
  NumberSeries,
  NumberSeriesCommand,
  NumberSeriesInput,
} from "@/lib/organization/number-series";
import { NumberSeriesForm } from "@/routes/_protected.settings/-components/organization/number-series-form";
import { numberSeriesPatch } from "@/routes/_protected.settings/-components/organization/number-series-form.logic";
import {
  NumberSeriesPreview,
  NumberSeriesRefusal,
} from "@/routes/_protected.settings/-components/organization/number-series-preview";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

type SeriesDialog =
  | { type: "closed" }
  | { type: "create" }
  | { type: "edit"; series: NumberSeries }
  | { type: "archive"; series: NumberSeries };
const DOCUMENT_TYPE_LABELS = {
  invoice: "billing.numberSeries.invoice",
  advance: "billing.numberSeries.advance",
  credit_note: "billing.numberSeries.creditNote",
} as const satisfies Record<NumberSeries["documentType"], string>;

export const NumberSeriesCard = () => {
  const preview = useTimeBillingPreviewEnabled();
  const canUpdate = usePermissions({ organizationSettings: ["update"] });
  const user = useAuthenticatedUser();
  if (!preview || !canUpdate) {
    return null;
  }
  return (
    <NumberSeriesCardBody
      key={user.activeOrganizationId}
      organizationId={user.activeOrganizationId}
    />
  );
};

const NumberSeriesCardBody = ({
  organizationId,
}: {
  organizationId: string;
}) => {
  const t = useTranslations();
  const query = useInfiniteQuery(numberSeriesOptions(organizationId));
  const [dialog, setDialog] = useState<SeriesDialog>({ type: "closed" });
  const [date, setDate] = useState(localISODate);
  const [preview, setPreview] = useState<
    { type: "closed" } | { type: "open"; id: string }
  >({ type: "closed" });
  const mutation = useSettingsMutation({
    mutationFn: sendNumberSeriesCommand,
    invalidate: numberSeriesKeys.all(organizationId),
  });
  const seriesList =
    query.data === undefined
      ? []
      : query.data.pages.flatMap((page) => page.items);
  const close = () => {
    if (!mutation.isPending) {
      setDialog({ type: "closed" });
      mutation.reset();
    }
  };
  const run = async (command: NumberSeriesCommand) => {
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
  const save = async (values: NumberSeriesInput) => {
    switch (dialog.type) {
      case "create":
        await run({ type: "create", values });
        return;
      case "edit":
        await run({
          type: "update",
          id: dialog.series.id,
          values: numberSeriesPatch({ original: dialog.series, next: values }),
        });
        return;
      case "closed":
      case "archive":
        return;
    }
  };
  const open = (next: SeriesDialog) => {
    mutation.reset();
    setDialog(next);
  };

  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-muted-foreground text-sm">
            {t("billing.numberSeries.description")}
          </p>
          <Button
            onClick={() => open({ type: "create" })}
            disabled={mutation.isPending}
          >
            {t("billing.numberSeries.add")}
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="number-series-issue-date">
            {t("billing.numberSeries.issueDate")}
          </Label>
          <DatePickerPopover
            id="number-series-issue-date"
            value={date}
            onChange={(next) => {
              if (next !== null) {
                setDate(next);
              }
            }}
          />
        </div>
        <p className="text-muted-foreground text-sm">
          {t("billing.numberSeries.previewHelp")}
        </p>
        {query.isPending && (
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        )}
        {query.error !== null && (
          <div className="flex items-center justify-between gap-2">
            <NumberSeriesRefusal error={query.error} />
            <Button
              variant="outline"
              onClick={() => detached(query.refetch(), "number-series.retry")}
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {mutation.error !== null && dialog.type === "closed" && (
          <NumberSeriesRefusal error={mutation.error} />
        )}
        {query.isSuccess && seriesList.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("billing.numberSeries.empty")}
          </p>
        )}
        {seriesList.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("billing.numberSeries.name")}</TableHead>
                <TableHead>{t("billing.numberSeries.documentType")}</TableHead>
                <TableHead>{t("billing.numberSeries.pattern")}</TableHead>
                <TableHead>{t("billing.numberSeries.preview")}</TableHead>
                <TableHead>{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {seriesList.map((series) => (
                <TableRow key={series.id}>
                  <TableCell>
                    <BidiText>{series.name}</BidiText>
                    {series.isDefault && (
                      <p className="text-muted-foreground text-xs">
                        {t("billing.numberSeries.default")}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    {t(DOCUMENT_TYPE_LABELS[series.documentType])}
                  </TableCell>
                  <TableCell>
                    <BidiText>{series.pattern}</BidiText>
                  </TableCell>
                  <TableCell>
                    {preview.type === "open" && preview.id === series.id ? (
                      <NumberSeriesPreview
                        organizationId={organizationId}
                        id={series.id}
                        date={date}
                      />
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setPreview({ type: "open", id: series.id })
                        }
                      >
                        {t("billing.numberSeries.preview")}
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => open({ type: "edit", series })}
                      >
                        {t("common.edit")}
                      </Button>
                      {!series.isDefault && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={mutation.isPending}
                          onClick={() =>
                            detached(
                              run({ type: "default", id: series.id }),
                              "number-series.default",
                            )
                          }
                        >
                          {t("billing.numberSeries.setDefault")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => open({ type: "archive", series })}
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
              detached(query.fetchNextPage(), "number-series.load-more")
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
                  {dialog.type === "create" && t("billing.numberSeries.add")}
                  {dialog.type === "edit" && t("billing.numberSeries.edit")}
                  {dialog.type === "archive" && t("common.archive")}
                </DialogTitle>
              </DialogHeader>
              {mutation.error !== null && (
                <DialogPanel>
                  <NumberSeriesRefusal error={mutation.error} />
                </DialogPanel>
              )}
              {dialog.type === "archive" ? (
                <>
                  <DialogPanel className="flex flex-col gap-4">
                    <p className="text-sm">
                      {t("billing.numberSeries.archiveConfirm")}
                    </p>
                    <BidiText>{dialog.series.name}</BidiText>
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
                          run({ type: "archive", id: dialog.series.id }),
                          "number-series.archive",
                        )
                      }
                    >
                      {t("common.archive")}
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <NumberSeriesForm
                  key={dialog.type === "edit" ? dialog.series.id : "new"}
                  {...(dialog.type === "edit" ? { series: dialog.series } : {})}
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
