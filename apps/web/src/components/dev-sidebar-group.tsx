import { useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";

import { sleep } from "@stll/concurrency/sleep";
import {
  DatabaseIcon,
  LibraryBigIcon,
  PlayIcon,
  RotateCcwIcon,
  Trash2Icon,
  WrenchIcon,
} from "@stll/ui/icons";
import {
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

import { PublicLawConnectionItem } from "@/components/dev/public-law-connection-item";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { useDevStore } from "@/lib/dev-store";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";

const SEED_STATUS_POLL_INTERVAL_MS = 1000;
const SEED_STATUS_MAX_POLLS = 180;
const FIRM_KNOWLEDGE_MAX_POLLS = 15 * 60;

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
 * the polling contract lives here once instead of per job.
 */
const pollSeedJob = async ({
  poll,
  onSucceeded,
  onFailed,
  onPending,
  maxPolls = SEED_STATUS_MAX_POLLS,
}: PollSeedJobOptions) => {
  for (let attempt = 0; attempt < maxPolls; attempt++) {
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
      notifyUserError(toAPIError(start.error), "Seed failed");
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
        notifyUserError(undefined, "Seed failed", {
          ...(message === undefined ? {} : { description: message }),
        });
      },
      onSucceeded: () => {
        setSeeding(false);
        detached(
          queryClient.invalidateQueries(),
          "dev-sidebar-group.invalidate",
        );
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
      notifyUserError(toAPIError(start.error), "Firm-knowledge seed failed");
      return;
    }

    if (start.data instanceof Response) {
      setSeedingFirmKnowledge(false);
      notifyUserError(undefined, "Firm-knowledge seed failed");
      return;
    }
    const jobId = start.data.jobId;

    await pollSeedJob({
      maxPolls: FIRM_KNOWLEDGE_MAX_POLLS,
      poll: async () => {
        const { data, error } = await api.dev["seed-firm-knowledge"].get({
          query: { jobId },
        });
        if (error !== null) {
          return null;
        }
        return data instanceof Response ? null : data;
      },
      onFailed: (message) => {
        setSeedingFirmKnowledge(false);
        notifyUserError(undefined, "Firm-knowledge seed failed", {
          ...(message === undefined ? {} : { description: message }),
        });
      },
      onSucceeded: () => {
        setSeedingFirmKnowledge(false);
        detached(
          queryClient.invalidateQueries(),
          "dev-sidebar-group.invalidate",
        );
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
      notifyUserError(toAPIError(error), "Clear cache failed");
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
      notifyUserError(toAPIError(error), "Clean failed");
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
        <PublicLawConnectionItem />
        <MenuSeparator />
        <MenuItem
          disabled={seeding}
          onClick={() => {
            detached(handleSeed(), "dev-sidebar-group.seed");
          }}
        >
          <DatabaseIcon />
          {seeding ? "Seeding..." : "Seed data"}
        </MenuItem>
        <MenuItem
          disabled={seedingFirmKnowledge}
          onClick={() => {
            detached(
              handleSeedFirmKnowledge(),
              "dev-sidebar-group.seed-firm-knowledge",
            );
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
            detached(handleClean(), "dev-sidebar-group.clean");
          }}
        >
          <Trash2Icon />
          {cleaning ? "Cleaning..." : "Clean data"}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={clearingCache}
          onClick={() => {
            detached(handleClearCache(), "dev-sidebar-group.clear-cache");
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
