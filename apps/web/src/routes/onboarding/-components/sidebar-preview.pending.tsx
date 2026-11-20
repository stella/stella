import type { ComponentType, ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { LibraryBigIcon, MessageSquareIcon, SearchIcon } from "@stll/ui/icons";
import { MattersNavIcon } from "@stll/ui/matter-icon";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

export const OnboardingSidebarFrame = ({
  children,
  wordmark,
}: {
  children: ReactNode;
  wordmark: ReactNode;
}) => (
  <div className="bg-background w-85 overflow-hidden rounded-xl shadow-lg">
    <div className="border-b px-4 py-3">{wordmark}</div>
    {children}
  </div>
);

export const OnboardingSidebarNavItem = ({
  icon: Icon,
  label,
  active,
  trailing,
}: {
  icon: ComponentType<{ className?: string }>;
  label: ReactNode;
  active?: boolean;
  trailing?: ReactNode;
}) => (
  <div
    className={cn(
      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
      active
        ? "bg-accent text-foreground font-medium"
        : "text-muted-foreground",
    )}
  >
    <Icon className="size-4" />
    {label}
    {trailing}
  </div>
);

const navigation = [
  { icon: SearchIcon, name: "navigation.search" },
  { icon: MessageSquareIcon, name: "navigation.chat" },
  { icon: MattersNavIcon, name: "common.matters" },
  { icon: LibraryBigIcon, name: "navigation.knowledge" },
] as const;

export const OnboardingSidebarPending = () => (
  <OnboardingSidebarFrame
    wordmark={<StellaWordmarkLatin className="h-4 w-auto" />}
  >
    <div className="text-foreground-subtle border-b px-4 py-2.5 text-sm font-medium">
      <PendingText id="onboarding.orgNameLabel" />
    </div>
    <div className="flex flex-col gap-0.5 px-3 py-3">
      {navigation.map(({ icon: Icon, name }) => (
        <OnboardingSidebarNavItem
          active={name === "common.matters"}
          icon={Icon}
          key={name}
          label={<PendingText id={name} barClassName="w-10" />}
        />
      ))}
    </div>
    <div className="px-3 py-2">
      <div className="text-muted-foreground text-2xs px-2 pb-1.5 font-medium tracking-wide uppercase">
        <PendingText id="common.matters" barClassName="w-10" />
      </div>
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
        <div className="bg-muted size-3.5 rounded-sm" />
        <FaceLabelPending className="w-24" />
      </div>
    </div>
  </OnboardingSidebarFrame>
);
