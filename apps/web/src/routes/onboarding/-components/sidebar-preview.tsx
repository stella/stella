import {
  ArrowRightIcon,
  BookOpenIcon,
  FileIcon,
  LayersIcon,
  MessageSquareIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { StellaWordmark } from "@/components/stella-wordmark";

type SidebarPreviewProps = {
  organizationName: string;
  matterName: string;
  dmsCount?: number;
  emailCount?: number;
};

const ANIMATION_STYLE = `
@keyframes slide-in {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes pulse-dot {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
@keyframes flow-in {
  0% { opacity: 0; transform: translateX(-12px); }
  60% { opacity: 1; transform: translateX(2px); }
  100% { opacity: 1; transform: translateX(0); }
}
.animate-slide-in {
  animation: slide-in 0.3s ease-out forwards;
}
.animate-flow-in {
  animation: flow-in 0.5s ease-out forwards;
}
.animate-pulse-dot {
  animation: pulse-dot 1.5s ease-in-out infinite;
}
`;

const NavItem = ({
  icon: Icon,
  label,
  active,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
}) => (
  <div
    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
      active ? "bg-accent text-foreground font-medium" : "text-muted-foreground"
    }`}
  >
    <Icon className="size-4" />
    <span>{label}</span>
  </div>
);

/**
 * Animated mock of the Stella sidebar for the onboarding
 * wizard. Shows contextual micro-animations based on the
 * current step's state.
 */
export const SidebarPreview = ({
  organizationName,
  matterName,
  dmsCount = 0,
  emailCount = 0,
}: SidebarPreviewProps) => {
  const t = useTranslations();

  return (
    <div className="bg-background w-[340px] overflow-hidden rounded-xl shadow-lg">
      <style>{ANIMATION_STYLE}</style>

      {/* Header */}
      <div className="border-b px-4 py-3">
        <StellaWordmark className="text-foreground h-4 w-auto" />
      </div>

      {/* Org name */}
      <div className="border-b px-4 py-2.5">
        <span className="text-foreground text-sm font-medium">
          {organizationName ? (
            <span
              key={organizationName}
              className="animate-slide-in inline-block"
            >
              {organizationName}
            </span>
          ) : (
            <span className="text-muted-foreground/50">
              {t("onboarding.orgNameLabel")}
            </span>
          )}
        </span>
      </div>

      {/* Search mock */}
      <div className="px-3 pt-3 pb-1">
        <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs">
          <SearchIcon className="size-3.5" />
          <span>{t("navigation.search")}...</span>
        </div>
      </div>

      {/* Nav items */}
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <NavItem active icon={LayersIcon} label={t("common.matters")} />
        <NavItem icon={BookOpenIcon} label={t("navigation.knowledge")} />
        <NavItem icon={MessageSquareIcon} label={t("navigation.chat")} />
      </div>

      {/* Documents section — shows import animation */}
      <div className="px-3 py-2">
        <div className="text-muted-foreground px-2 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
          {t("common.matters")}
        </div>

        {dmsCount > 0 ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: Math.min(dmsCount, 3) }, (_, i) => (
              <div
                className="animate-flow-in flex items-center gap-2 rounded-md px-2 py-1.5"
                key={i}
                style={{ animationDelay: `${i * 150}ms` }}
              >
                <ArrowRightIcon className="text-primary size-3 shrink-0" />
                <FileIcon className="size-3.5 shrink-0 text-blue-500" />
                <div
                  className="bg-muted h-2.5 rounded"
                  style={{ width: `${60 + i * 20}px` }}
                />
              </div>
            ))}
          </div>
        ) : matterName ? (
          <div className="animate-slide-in flex items-center gap-2 rounded-md px-2 py-1.5">
            <LayersIcon className="size-3.5 shrink-0 text-blue-500" />
            <span className="text-foreground truncate text-sm">
              {matterName}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div className="bg-muted size-3.5 rounded" />
            <div className="bg-muted h-3 w-24 rounded" />
          </div>
        )}
      </div>

      {/* Team members — shows dots when emails are added */}
      {emailCount > 0 && (
        <div className="border-t px-4 py-3">
          <div className="flex items-center gap-2">
            <UsersIcon className="text-muted-foreground size-3.5" />
            <div className="flex -space-x-1">
              {Array.from({ length: Math.min(emailCount, 5) }, (_, i) => (
                <div
                  className="animate-flow-in bg-primary/20 border-background size-5 rounded-full border-2"
                  key={i}
                  style={{
                    animationDelay: `${i * 100}ms`,
                  }}
                />
              ))}
              {emailCount > 5 && (
                <div className="bg-muted border-background flex size-5 items-center justify-center rounded-full border-2 text-[9px]">
                  +{emailCount - 5}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
