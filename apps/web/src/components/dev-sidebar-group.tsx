import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import {
  DatabaseIcon,
  LibraryBigIcon,
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
} from "@stll/ui/components/menu";
import { stellaToast } from "@stll/ui/components/toast";

import {
  encodeModelSelection,
  MODEL_OPTIONS_BY_PROVIDER,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
} from "@/components/ai-config-role-models.logic";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { useDevStore } from "@/lib/dev-store";

/**
 * Options for the dev-only chat-model override.
 *
 * Sourced from MODEL_OPTIONS_BY_PROVIDER — the same catalog the org
 * BYOK picker uses — so this list never drifts from the real model
 * catalog. Values carry the provider so the API routes the override
 * through the matching model factory instead of the active provider.
 */
const CHAT_MODELS: { value: string; label: string }[] = [
  // Empty value falls through to getModelForRole("chat") on the API.
  { value: "", label: "Default (chat role)" },
  ...PROVIDER_KEYS.flatMap((provider) =>
    MODEL_OPTIONS_BY_PROVIDER[provider].map((modelId) => ({
      value: encodeModelSelection({ provider, modelId }),
      label: `${PROVIDER_LABELS[provider]} · ${modelId}`,
    })),
  ),
];

const SEED_STATUS_POLL_INTERVAL_MS = 1000;
const SEED_STATUS_MAX_POLLS = 180;
const FIRM_KNOWLEDGE_MAX_POLLS = 15 * 60;

const sleep = async (ms: number) =>
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type SeedJobStatus =
  | { status: "idle" }
  | { status: "running" }
  | { status: "succeeded" }
  | { status: "failed"; message: string };

type PollSeedJobOptions = {
  /**
   * Reads the job's current status, or null when there is nothing to act on:
   * a failed request, or the raw Response the endpoint answers an
   * unauthenticated caller with. Callers inspect Eden's error channel here so
   * this helper never handles a half-checked response.
   */
  poll: () => Promise<SeedJobStatus | null>;
  onSucceeded: () => void;
  onFailed: (message: string | undefined) => void;
  /** Still running when the poll budget ran out. */
  onPending: () => void;
  maxPolls?: number;
};

/**
 * Drive one start-then-poll seed job to a terminal state.
 *
 * Shared by both seeds: the loop is the only place that awaits in sequence, so
 * the `no-await-in-loop` exceptions live here once instead of per job.
 */
const pollSeedJob = async ({
  poll,
  onSucceeded,
  onFailed,
  onPending,
  maxPolls = SEED_STATUS_MAX_POLLS,
}: PollSeedJobOptions) => {
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- sequential status poll: each probe reflects progress after the prior interval
    const status = await poll();
    if (status === null) {
      onFailed(undefined);
      return;
    }
    if (status.status === "failed") {
      onFailed(status.message);
      return;
    }
    if (status.status === "succeeded") {
      onSucceeded();
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential poll backoff: wait between status probes
    await sleep(SEED_STATUS_POLL_INTERVAL_MS);
  }
  onPending();
};

export const DevSidebarGroup = () => {
  const queryClient = useQueryClient();
  const [seeding, setSeeding] = useState(false);
  const [seedingFirmKnowledge, setSeedingFirmKnowledge] = useState(false);
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
      reactGrab: s.reactGrab,
      setReactGrab: s.setReactGrab,
      publicLawPreview: s.publicLawPreview,
      setPublicLawPreview: s.setPublicLawPreview,
      simulateSlowLoad: s.simulateSlowLoad,
      setSimulateSlowLoad: s.setSimulateSlowLoad,
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

    await pollSeedJob({
      poll: async () => {
        const { data, error } = await api.dev.seed.get();
        if (error !== null) {
          return null;
        }
        return data instanceof Response ? null : data;
      },
      onFailed: (message) => {
        setSeeding(false);
        stellaToast.add({
          title: "Seed failed",
          ...(message === undefined ? {} : { description: message }),
          type: "error",
        });
      },
      onSucceeded: () => {
        setSeeding(false);
        detached(queryClient.invalidateQueries(), "DevSidebarGroup");
        stellaToast.add({ title: "Dev data seeded", type: "success" });
      },
      onPending: () => {
        setSeeding(false);
        stellaToast.add({ title: "Seed still running", type: "info" });
      },
    });
  };

  // Same start-then-poll shape as handleSeed, against the firm-knowledge job.
  // Uploads run through the real endpoints, so this is minutes, not seconds.
  const handleSeedFirmKnowledge = async () => {
    setSeedingFirmKnowledge(true);
    const start = await api.dev["seed-firm-knowledge"].post();
    if (start.error) {
      setSeedingFirmKnowledge(false);
      stellaToast.add({ title: "Firm-knowledge seed failed", type: "error" });
      return;
    }

    await pollSeedJob({
      maxPolls: FIRM_KNOWLEDGE_MAX_POLLS,
      poll: async () => {
        const { data, error } = await api.dev["seed-firm-knowledge"].get();
        if (error !== null) {
          return null;
        }
        return data instanceof Response ? null : data;
      },
      onFailed: (message) => {
        setSeedingFirmKnowledge(false);
        stellaToast.add({
          title: "Firm-knowledge seed failed",
          ...(message === undefined ? {} : { description: message }),
          type: "error",
        });
      },
      onSucceeded: () => {
        setSeedingFirmKnowledge(false);
        detached(queryClient.invalidateQueries(), "DevSidebarGroup");
        stellaToast.add({
          title: "Firm knowledge seeded",
          description: "Text extraction continues in the background.",
          type: "success",
        });
      },
      onPending: () => {
        setSeedingFirmKnowledge(false);
        stellaToast.add({ title: "Seed still running", type: "info" });
      },
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
        <MenuCheckboxItem
          checked={dev.publicLawPreview}
          onClick={() => dev.setPublicLawPreview(!dev.publicLawPreview)}
          variant="switch"
        >
          Public law preview
        </MenuCheckboxItem>
        <MenuCheckboxItem
          checked={dev.simulateSlowLoad}
          onClick={() => dev.setSimulateSlowLoad(!dev.simulateSlowLoad)}
          variant="switch"
        >
          Simulate slow load
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
            detached(handleSeed(), "DevSidebarGroup");
          }}
        >
          <DatabaseIcon />
          {seeding ? "Seeding..." : "Seed data"}
        </MenuItem>
        <MenuItem
          disabled={seedingFirmKnowledge}
          onClick={() => {
            detached(handleSeedFirmKnowledge(), "DevSidebarGroup");
          }}
        >
          <LibraryBigIcon />
          {seedingFirmKnowledge
            ? "Seeding firm knowledge..."
            : "Seed firm knowledge"}
        </MenuItem>
        <MenuItem
          disabled={cleaning}
          onClick={() => {
            detached(handleClean(), "DevSidebarGroup");
          }}
        >
          <Trash2Icon />
          {cleaning ? "Cleaning..." : "Clean data"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={clearingCache}
          onClick={() => {
            detached(handleClearCache(), "DevSidebarGroup");
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
      </MenuSubPopup>
    </MenuSub>
  );
};
