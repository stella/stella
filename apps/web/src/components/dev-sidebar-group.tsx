import { useState } from "react";

import {
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  DatabaseIcon,
  ExternalLinkIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { env } from "@/env";
import { api } from "@/lib/api";
import { useDevStore } from "@/lib/dev-store";

// Build the AI SDK DevTools URL from VITE_API_URL's host so it
// follows the same per-worktree port offset, then swap in the
// devtools port (default 4983, override with VITE_AI_SDK_DEVTOOLS_PORT).
const aiSdkDevtoolsUrl = (() => {
  const apiUrl = new URL(env.VITE_API_URL);
  apiUrl.port = String(env.VITE_AI_SDK_DEVTOOLS_PORT);
  apiUrl.pathname = "/";
  return apiUrl.toString();
})();

/**
 * Models available in the dev model selector.
 *
 * Grouped by role (matching ai-models.ts constants on the
 * backend) and by provider for manual overrides.
 */
const CHAT_MODELS = [
  // Default: uses CHAT_MODEL from ai-models.ts
  { value: "", label: "Default (Gemini 3 Flash)" },

  // --- Low ($0.50–$3/M output) ---
  { value: "openai/gpt-5-mini", label: "GPT-5 Mini · Low" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash · Low" },
  {
    value: "google/gemini-3-flash-preview",
    label: "Gemini 3.0 Flash · Low",
  },
  {
    value: "perplexity/sonar",
    label: "Sonar (web search) · Low",
  },

  // --- Mid ($5–$12/M output) ---
  {
    value: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5 · Mid",
  },
  { value: "openai/o3", label: "o3 · Mid" },
  { value: "openai/gpt-5", label: "GPT-5 · Mid" },
  {
    value: "google/gemini-3-pro-preview",
    label: "Gemini 3.0 Pro · Mid",
  },
  {
    value: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro · Mid",
  },

  // --- High ($14–$15/M output) ---
  {
    value: "openai/gpt-5.3-codex",
    label: "GPT-5.3 Codex · High",
  },
  { value: "openai/gpt-5.4", label: "GPT-5.4 · High" },
  {
    value: "perplexity/sonar-pro",
    label: "Sonar Pro (web search) · High",
  },
  {
    value: "anthropic/claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 · High",
  },
] as const;

const SEED_STATUS_POLL_INTERVAL_MS = 1000;
const SEED_STATUS_MAX_POLLS = 180;

const sleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const DevSidebarGroup = () => {
  const queryClient = useQueryClient();
  const [seeding, setSeeding] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const dev = useDevStore(
    useShallow((s) => ({
      tanstackDevtools: s.tanstackDevtools,
      setTanstackDevtools: s.setTanstackDevtools,
      sourceInspector: s.sourceInspector,
      setSourceInspector: s.setSourceInspector,
      chatModelId: s.chatModelId,
      setChatModelId: s.setChatModelId,
      showToolCallDetails: s.showToolCallDetails,
      setShowToolCallDetails: s.setShowToolCallDetails,
      reactGrab: s.reactGrab,
      setReactGrab: s.setReactGrab,
    })),
  );

  const handleSeed = async () => {
    setSeeding(true);
    const start = await api.dev.seed.post();
    if (start.error) {
      setSeeding(false);
      stellaToast.add({ title: "Seed failed", type: "error" });
      return;
    }

    for (let i = 0; i < SEED_STATUS_MAX_POLLS; i++) {
      const status = await api.dev.seed.get();
      if (status.error) {
        setSeeding(false);
        stellaToast.add({ title: "Seed status failed", type: "error" });
        return;
      }

      if (status.data.status === "failed") {
        setSeeding(false);
        stellaToast.add({
          title: "Seed failed",
          description: status.data.message,
          type: "error",
        });
        return;
      }

      if (status.data.status === "succeeded") {
        setSeeding(false);
        await queryClient.invalidateQueries();
        stellaToast.add({
          title: "Dev data seeded",
          type: "success",
        });
        return;
      }

      await sleep(SEED_STATUS_POLL_INTERVAL_MS);
    }

    setSeeding(false);
    stellaToast.add({
      title: "Seed still running",
      type: "info",
    });
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    const { error } = await api.dev["clear-cache"].post();
    setClearingCache(false);
    if (error) {
      stellaToast.add({
        title: "Clear cache failed",
        type: "error",
      });
      return;
    }
    queryClient.clear();
    stellaToast.add({
      title: "Cache cleared, reloading…",
      type: "success",
    });
    setTimeout(() => window.location.reload(), 500);
  };

  const handleClean = async () => {
    setCleaning(true);
    const { error } = await api.dev.clean.post();
    setCleaning(false);
    if (error) {
      stellaToast.add({
        title: "Clean failed",
        type: "error",
      });
      return;
    }
    await queryClient.invalidateQueries();
    stellaToast.add({
      title: "Dev data cleaned",
      type: "success",
    });
  };

  return (
    <MenuSub>
      <MenuSubTrigger>
        <WrenchIcon />
        Dev
      </MenuSubTrigger>
      <MenuSubPopup>
        <MenuCheckboxItem
          checked={dev.tanstackDevtools}
          onClick={() => dev.setTanstackDevtools(!dev.tanstackDevtools)}
          variant="switch"
        >
          TanStack Devtools
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.sourceInspector}
          onClick={() => dev.setSourceInspector(!dev.sourceInspector)}
          variant="switch"
        >
          Source Inspector
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.showToolCallDetails}
          onClick={() => dev.setShowToolCallDetails(!dev.showToolCallDetails)}
          variant="switch"
        >
          Detailed Tool Calls
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.reactGrab}
          onClick={() => {
            const next = !dev.reactGrab;
            dev.setReactGrab(next);
            window.location.reload();
          }}
          variant="switch"
        >
          React Grab
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Chat Model</MenuGroupLabel>
          <MenuRadioGroup value={dev.chatModelId ?? ""}>
            {CHAT_MODELS.map((m) => (
              <MenuRadioItem
                key={m.value}
                onClick={() => dev.setChatModelId(m.value || null)}
                value={m.value}
              >
                {m.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          disabled={seeding}
          onClick={() => {
            void handleSeed();
          }}
        >
          <DatabaseIcon />
          {seeding ? "Seeding..." : "Seed data"}
        </MenuItem>
        <MenuItem
          disabled={cleaning}
          onClick={() => {
            void handleClean();
          }}
        >
          <Trash2Icon />
          {cleaning ? "Cleaning..." : "Clean data"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={clearingCache}
          onClick={() => {
            void handleClearCache();
          }}
        >
          <RotateCcwIcon />
          {clearingCache ? "Clearing…" : "Clear cache"}
        </MenuItem>
        <MenuItem
          onClick={() => {
            window.location.href = "/onboarding?preview=true";
          }}
        >
          <PlayIcon />
          Onboard again
        </MenuItem>
        <MenuItem
          onClick={() => {
            window.location.href = "/dev";
          }}
        >
          <WrenchIcon />
          UI playground
        </MenuItem>
        <MenuItem
          disabled={!env.VITE_AI_DEVTOOLS_ENABLED}
          onClick={() => {
            // Dev-runner only spawns the devtools CLI when
            // AI_DEVTOOLS_ENABLED=true in apps/api/.env, so the
            // disabled state mirrors that gate.
            window.open(aiSdkDevtoolsUrl, "_blank", "noopener,noreferrer");
          }}
        >
          <SparklesIcon />
          AI SDK Devtools
          {env.VITE_AI_DEVTOOLS_ENABLED ? (
            <ExternalLinkIcon className="ms-auto size-3 opacity-60" />
          ) : (
            <span className="ms-auto text-[0.625rem] opacity-60">
              Set AI_DEVTOOLS_ENABLED
            </span>
          )}
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
};
