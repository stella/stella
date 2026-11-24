import type { ComponentProps, ComponentType } from "react";

import { panic } from "better-result";

import type { ChatLocalRunHarness } from "@stll/api-contract/chat-run-target";
import {
  AntigravityLogoIcon,
  ClaudeLogoIcon,
  GeminiLogoIcon,
  OpenAILogoIcon,
} from "@stll/ui/brand-icons";
import { BlocksIcon, SparklesIcon, WindIcon } from "@stll/ui/icons";

import type { ProviderValue } from "@/components/ai-config-role-models.logic";

type IconProps = ComponentProps<"svg">;
type IconComponent = ComponentType<IconProps>;

const PROVIDER_ICONS = {
  google: GeminiLogoIcon,
  anthropic: ClaudeLogoIcon,
  openai: OpenAILogoIcon,
  openrouter: SparklesIcon,
  mistral: WindIcon,
  bedrock: BlocksIcon,
} as const satisfies Record<ProviderValue, IconComponent>;

export const getProviderIcon = (provider: ProviderValue): IconComponent =>
  PROVIDER_ICONS[provider];

export const AIProviderIcon = ({
  provider,
  ...props
}: IconProps & { provider: ProviderValue }) => {
  switch (provider) {
    case "google":
      return <GeminiLogoIcon {...props} />;
    case "anthropic":
      return <ClaudeLogoIcon {...props} />;
    case "openai":
      return <OpenAILogoIcon {...props} />;
    case "openrouter":
      return <SparklesIcon {...props} />;
    case "mistral":
      return <WindIcon {...props} />;
    case "bedrock":
      return <BlocksIcon {...props} />;
    default:
      provider satisfies never;
      return panic(`Unhandled provider: ${String(provider)}`);
  }
};

export const LocalHarnessIcon = ({
  harness,
  ...props
}: IconProps & { harness: ChatLocalRunHarness }) => {
  switch (harness) {
    case "codex":
      return <OpenAILogoIcon {...props} />;
    case "claude-code":
      return <ClaudeLogoIcon {...props} />;
    case "antigravity":
      return <AntigravityLogoIcon {...props} />;
    default:
      harness satisfies never;
      return panic(`Unhandled local harness: ${String(harness)}`);
  }
};
