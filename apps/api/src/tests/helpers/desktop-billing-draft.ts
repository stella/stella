import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";

type DesktopBillingDraftRequestOptions = {
  matterId: string;
  entry?: Omit<
    Partial<DesktopBillingDraftRequest["entries"][number]>,
    "entryId" | "matterId"
  >;
};

export const createDesktopBillingDraftRequest = ({
  matterId,
  entry,
}: DesktopBillingDraftRequestOptions): DesktopBillingDraftRequest => ({
  entries: [
    {
      entryId: "entry_1",
      matterId,
      date: "2026-10-09",
      timezone: "Europe/Prague",
      durationMinutes: 30,
      appNames: ["Editor"],
      ...entry,
    },
  ],
});
