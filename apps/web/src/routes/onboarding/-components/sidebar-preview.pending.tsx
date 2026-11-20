import type { ReactNode } from "react";

import { LibraryBigIcon, MessageSquareIcon, SearchIcon } from "@stll/ui/icons";
import { MattersNavIcon } from "@stll/ui/matter-icon";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";
import { TruncatedTextFace } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

const navigation = [
  { icon: SearchIcon, name: "navigation.search" },
  { icon: MessageSquareIcon, name: "navigation.chat" },
  { icon: MattersNavIcon, name: "common.matters" },
  { icon: LibraryBigIcon, name: "navigation.knowledge" },
] as const;

type SidebarLabel =
  (typeof navigation)[number]["name"] | "onboarding.orgNameLabel";

const pendingLabel = (id: SidebarLabel) => <PendingText id={id} />;
const pendingNavLabel = (id: SidebarLabel) => (
  <TruncatedTextFace className="flex-1">{pendingLabel(id)}</TruncatedTextFace>
);

export const OnboardingSidebarFrame = ({
  children,
  wordmark,
  organization,
  matter,
  label = pendingLabel,
  navLabel = pendingNavLabel,
  chatActive = false,
  searchHint,
}: {
  children?: ReactNode;
  wordmark?: ReactNode;
  organization?: ReactNode;
  matter?: ReactNode;
  label?: (id: SidebarLabel) => ReactNode;
  navLabel?: (id: SidebarLabel) => ReactNode;
  chatActive?: boolean;
  searchHint?: ReactNode;
}) => (
  <div className="bg-background w-85 overflow-hidden rounded-xl shadow-lg">
    <div className="border-b px-4 py-3">
      {wordmark ?? <StellaWordmarkLatin className="h-4 w-auto" />}
    </div>
    <div className="border-b px-4 py-2.5">
      {organization ?? (
        <div className="text-foreground-subtle text-sm font-medium">
          {label("onboarding.orgNameLabel")}
        </div>
      )}
    </div>
    <div className="flex flex-col gap-0.5 px-3 py-3">
      {navigation.map(({ icon: Icon, name }) => (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            name === (chatActive ? "navigation.chat" : "common.matters")
              ? "bg-accent text-foreground font-medium"
              : "text-muted-foreground",
          )}
          key={name}
        >
          <Icon className="size-4" />
          {navLabel(name)}
          {name === "navigation.search" && searchHint}
        </div>
      ))}
    </div>
    <div className="px-3 py-2">
      <div className="text-muted-foreground text-2xs px-2 pb-1.5 font-medium tracking-wide uppercase">
        {label("common.matters")}
      </div>
      {matter ?? (
        <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <div className="bg-muted size-3.5 rounded-sm" />
          <div className="bg-muted h-3 w-24 rounded-sm" />
        </div>
      )}
    </div>
    {children}
  </div>
);
