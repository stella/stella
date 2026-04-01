import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import {
  DatabaseIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";

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
} from "@stella/ui/components/menu";
import { toastManager } from "@stella/ui/components/toast";

import { api } from "@/lib/api";
import { useDevStore } from "@/lib/dev-store";

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

export const DevSidebarGroup = () => {
  const queryClient = useQueryClient();
  const [seeding, setSeeding] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const dev = useDevStore(
    useShallow((s) => ({
      tanstackDevtools: s.tanstackDevtools,
      setTanstackDevtools: s.setTanstackDevtools,
      rivetDevtools: s.rivetDevtools,
      setRivetDevtools: s.setRivetDevtools,
      sourceInspector: s.sourceInspector,
      setSourceInspector: s.setSourceInspector,
      chatModelId: s.chatModelId,
      setChatModelId: s.setChatModelId,
      showToolCalls: s.showToolCalls,
      setShowToolCalls: s.setShowToolCalls,
      reactGrab: s.reactGrab,
      setReactGrab: s.setReactGrab,
    })),
  );

  const handleSeed = async () => {
    setSeeding(true);
    const { error } = await api.dev.seed.post();
    setSeeding(false);
    if (error) {
      toastManager.add({
        title: "Seed failed",
        type: "error",
      });
      return;
    }
    await queryClient.invalidateQueries();
    toastManager.add({
      title: "Dev data seeded",
      type: "success",
    });
  };

  const handleClearCache = async () => {
    setClearingCache(true);
    const { error } = await api.dev["clear-cache"].post();
    setClearingCache(false);
    if (error) {
      toastManager.add({
        title: "Clear cache failed",
        type: "error",
      });
      return;
    }
    queryClient.clear();
    toastManager.add({
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
      toastManager.add({
        title: "Clean failed",
        type: "error",
      });
      return;
    }
    await queryClient.invalidateQueries();
    toastManager.add({
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
          checked={dev.rivetDevtools}
          onClick={() => dev.setRivetDevtools(!dev.rivetDevtools)}
          variant="switch"
        >
          Rivet Devtools
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.sourceInspector}
          onClick={() => dev.setSourceInspector(!dev.sourceInspector)}
          variant="switch"
        >
          Source Inspector
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.showToolCalls}
          onClick={() => dev.setShowToolCalls(!dev.showToolCalls)}
          variant="switch"
        >
          Show Tool Calls
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
        {/* eslint-disable-next-line typescript/no-misused-promises */}
        <MenuItem disabled={seeding} onClick={handleSeed}>
          <DatabaseIcon />
          {seeding ? "Seeding..." : "Seed data"}
        </MenuItem>
        {/* eslint-disable-next-line typescript/no-misused-promises */}
        <MenuItem disabled={cleaning} onClick={handleClean}>
          <Trash2Icon />
          {cleaning ? "Cleaning..." : "Clean data"}
        </MenuItem>
        <MenuSeparator />
        {/* eslint-disable-next-line typescript/no-misused-promises */}
        <MenuItem disabled={clearingCache} onClick={handleClearCache}>
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
      </MenuSubPopup>
    </MenuSub>
  );
};
