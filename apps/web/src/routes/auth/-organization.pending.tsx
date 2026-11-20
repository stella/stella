import type { ReactNode } from "react";

import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { ListItemSkeleton } from "@stll/ui/list-shell";
import { cn } from "@stll/ui/utils";

import {
  OAuthAccountList,
  OAuthAccountRowPending,
} from "@/components/oauth-consent/consent-control-faces.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

export const OrganizationPageShell = ({
  children,
}: {
  children: ReactNode;
}) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3">
    {children}
  </div>
);

export const OrganizationPickerShell = ({
  account,
  children,
  description,
  title,
}: {
  account: ReactNode;
  children: ReactNode;
  description: ReactNode;
  title: ReactNode;
}) => (
  <Frame className="w-full max-w-sm">
    <FrameHeader>
      <FrameTitle>{title}</FrameTitle>
      <FrameDescription>{description}</FrameDescription>
      {account}
    </FrameHeader>
    <FramePanel className="flex flex-col gap-2">{children}</FramePanel>
  </Frame>
);

export const OrganizationRowFace = ({
  children,
  dimmed = false,
  as: Element = "span",
}: {
  children: ReactNode;
  dimmed?: boolean;
  as?: "span" | "div";
}) => (
  <Element
    className={cn(
      "hover:bg-accent/50 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-start",
      dimmed && "opacity-64",
    )}
    data-slot="organization-row"
  >
    {children}
  </Element>
);

export const OrganizationPendingBody = ({ rowCount }: { rowCount: number }) => (
  <OrganizationPickerShell
    account={
      <div aria-hidden="true" className="mt-3">
        <OAuthAccountList>
          <OAuthAccountRowPending />
        </OAuthAccountList>
      </div>
    }
    description={
      <PendingText id="auth.chooseOrganization" barClassName="w-64" />
    }
    title={<PendingText id="auth.selectOrganization" barClassName="w-48" />}
  >
    {Array.from({ length: rowCount }, (_, index) => (
      <OrganizationRowFace as="div" key={index}>
        <ul className="w-full [&_[data-slot=list-item-skeleton]>div]:min-h-11 [&_[data-slot=list-item-skeleton]>div]:p-0 [&_[data-slot=list-item-skeleton]>div>div:first-child]:size-10">
          <ListItemSkeleton index={index} media />
        </ul>
      </OrganizationRowFace>
    ))}
  </OrganizationPickerShell>
);

export const OrganizationPending = framePendingView(() => (
  <OrganizationPageShell>
    <OrganizationPendingBody rowCount={2} />
  </OrganizationPageShell>
));
