import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { formatForDisplay } from "@tanstack/react-hotkeys";
import {
  BookOpenIcon,
  LayersIcon,
  MessageSquareIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { PROVIDER_LABELS } from "@/components/ai-config-role-models.logic";
import type {
  ProviderPreview,
  ProviderValidationStatus,
} from "@/components/ai-config-role-models.logic";
import { getProviderIcon } from "@/components/ai-provider-icons";
import { StellaWordmark } from "@/components/stella-wordmark";
import { HOTKEYS } from "@/lib/hotkeys";

type SidebarPreviewProps = {
  organizationName: string;
  matterName: string;
  emailCount?: number;
  aiProviders?: readonly ProviderPreview[];
  chatActive?: boolean;
};

const STATUS_DOT_CLASS: Record<ProviderValidationStatus, string> = {
  checking: "bg-muted-foreground",
  valid: "bg-emerald-500",
  invalid: "bg-rose-500",
};

const ANIMATION_STYLE = `
@keyframes slide-in {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
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
`;

const NavItem = ({
  icon: Icon,
  label,
  active,
  trailing,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  trailing?: ReactNode;
}) => (
  <div
    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
      active ? "bg-accent text-foreground font-medium" : "text-muted-foreground"
    }`}
  >
    <Icon className="size-4" />
    <span className="flex-1 truncate">{label}</span>
    {trailing}
  </div>
);

/**
 * Animated mock of the Stella sidebar for the onboarding
 * wizard. Shows contextual micro-animations based on the
 * current step's state.
 */
const EMPTY_PROVIDERS: readonly ProviderPreview[] = [];
const PULSE_DURATION_MS = 1500;

export const SidebarPreview = ({
  organizationName,
  matterName,
  emailCount = 0,
  aiProviders = EMPTY_PROVIDERS,
  chatActive = false,
}: SidebarPreviewProps) => {
  const t = useTranslations();
  const tOrganization = useTranslations("organization");
  const showChatActive = chatActive || aiProviders.length > 0;
  // Single shared pulse state so every dot blinks in lockstep,
  // regardless of when each row mounted.
  const [pulseOn, setPulseOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setPulseOn((v) => !v), PULSE_DURATION_MS / 2);
    return () => clearInterval(id);
  }, []);

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
            <span className="text-foreground-subtle">
              {t("onboarding.orgNameLabel")}
            </span>
          )}
        </span>
      </div>

      {/* Nav items */}
      <div className="flex flex-col gap-0.5 px-3 py-3">
        <NavItem
          icon={SearchIcon}
          label={t("navigation.search")}
          trailing={
            <kbd className="text-foreground-strong-muted text-[0.625rem]">
              {formatForDisplay(HOTKEYS.SEARCH)}
            </kbd>
          }
        />
        <NavItem
          active={showChatActive}
          icon={MessageSquareIcon}
          label={t("navigation.chat")}
        />
        <NavItem
          active={!showChatActive}
          icon={LayersIcon}
          label={t("common.matters")}
        />
        <NavItem icon={BookOpenIcon} label={t("navigation.knowledge")} />
      </div>

      {/* Documents section — placeholder skeleton when no matter exists */}
      <div className="px-3 py-2">
        <div className="text-muted-foreground px-2 pb-1.5 text-[11px] font-medium tracking-wide uppercase">
          {t("common.matters")}
        </div>

        {matterName ? (
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

      {/* AI status — one row per configured provider */}
      {aiProviders.length > 0 && (
        <div className="flex flex-col border-t">
          {aiProviders.map(({ provider, status }, index) => {
            const ProviderIcon = getProviderIcon(provider);
            const dotShouldPulse = status !== "invalid";
            return (
              <div
                className="animate-flow-in flex items-center gap-2 border-b px-4 py-2 last:border-b-0"
                key={provider}
                style={{ animationDelay: `${index * 120}ms` }}
              >
                <ProviderIcon className="text-foreground size-3.5 shrink-0" />
                <span className="text-foreground text-xs font-medium">
                  {PROVIDER_LABELS[provider]}
                </span>
                <span className="ms-auto flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full transition-opacity duration-500 ease-in-out ${STATUS_DOT_CLASS[status]}`}
                    style={{ opacity: dotShouldPulse && !pulseOn ? 0.3 : 1 }}
                  />
                  <span className="text-foreground-strong-muted text-[10px] tracking-wide uppercase">
                    {tOrganization(
                      status === "invalid"
                        ? "aiConfig.providerKeyInvalidShort"
                        : "aiConfig.active",
                    )}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}

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
