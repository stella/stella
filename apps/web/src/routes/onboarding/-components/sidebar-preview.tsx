import { useState } from "react";

import { useTranslations } from "use-intl";

import { useMountEffect } from "@stll/ui/effects";
import { UsersIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { PROVIDER_LABELS } from "@/components/ai-config-role-models.logic";
import type {
  ProviderPreview,
  ProviderValidationStatus,
} from "@/components/ai-config-role-models.logic";
import { getProviderIcon } from "@/components/ai-provider-icons";
import { StellaWordmark } from "@/components/stella-wordmark";
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { formatHotkeyForPlatform, HOTKEYS } from "@/lib/hotkeys";

import { OnboardingSidebarFrame } from "./sidebar-preview.pending";

type SidebarPreviewProps = {
  organizationName: string;
  matterName: string;
  emailCount?: number;
  aiProviders?: readonly ProviderPreview[];
  chatActive?: boolean;
};

const STATUS_DOT_CLASS: Record<ProviderValidationStatus, string> = {
  checking: "bg-muted-foreground",
  valid: "bg-success",
  invalid: "bg-destructive",
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
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const showChatActive = chatActive || aiProviders.length > 0;
  // Single shared pulse state so every dot blinks in lockstep,
  // regardless of when each row mounted.
  const [pulseOn, setPulseOn] = useState(true);
  useMountEffect(() => {
    const id = setInterval(() => setPulseOn((v) => !v), PULSE_DURATION_MS / 2);
    return () => clearInterval(id);
  });

  return (
    <OnboardingSidebarFrame
      chatActive={showChatActive}
      label={(id) => t(id)}
      navLabel={(id) => (
        <TruncatedText className="flex-1">{t(id)}</TruncatedText>
      )}
      matter={
        matterName ? (
          <div className="animate-slide-in flex items-center gap-2 rounded-md px-2 py-1.5">
            <MatterIcon
              className="size-3.5 shrink-0"
              matter={{ id: matterName, color: null }}
            />
            <TruncatedText className="text-foreground text-sm">
              {matterName}
            </TruncatedText>
          </div>
        ) : undefined
      }
      organization={
        organizationName ? (
          <TruncatedText
            className="animate-slide-in text-foreground text-sm font-medium"
            render={<div />}
          >
            {organizationName}
          </TruncatedText>
        ) : undefined
      }
      searchHint={
        <kbd className="text-foreground-strong-muted text-3xs">
          {formatHotkeyForPlatform(HOTKEYS.SEARCH, hotkeyPlatform)}
        </kbd>
      }
      wordmark={<StellaWordmark className="text-foreground h-4 w-auto" />}
    >
      <style>{ANIMATION_STYLE}</style>

      {/* AI status — one row per configured provider */}
      {aiProviders.length > 0 && (
        <div className="flex flex-col border-t">
          {aiProviders.map(({ provider, status }, index) => {
            const ProviderIcon = getProviderIcon(provider);
            const dotShouldPulse = status !== "invalid";
            const statusLabel =
              status === "invalid"
                ? tOrganization("aiConfig.providerKeyInvalidShort")
                : t("common.active");
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
                    className={cn(
                      "size-1.5 rounded-full transition-opacity duration-500 ease-in-out",
                      STATUS_DOT_CLASS[status],
                    )}
                    style={{ opacity: dotShouldPulse && !pulseOn ? 0.3 : 1 }}
                  />
                  <span className="text-foreground-strong-muted text-3xs tracking-wide uppercase">
                    {statusLabel}
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
    </OnboardingSidebarFrame>
  );
};
