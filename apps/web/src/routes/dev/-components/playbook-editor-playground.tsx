import { useState } from "react";

import { QueryClientProvider } from "@tanstack/react-query";

import { PlaybookEditor } from "@/features/knowledge/playbook-editor/playbook-editor";
import { createPlaybookBaseline } from "@/features/knowledge/playbook-editor/playbook-editor.logic";
import {
  discardParkedPlaybookPane,
  parkPlaybookPane,
} from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import type { ParkedPlaybookPane } from "@/features/knowledge/playbook-editor/playbook-pane-parking";
import { useMountEffect } from "@/hooks/use-effect";
import type { api } from "@/lib/api";
import { roleOptions } from "@/lib/auth-queries";
import {
  documentTypesOptions,
  playbookDetailOptions,
} from "@/lib/knowledge/queries";
import { createAppQueryClient } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

import {
  playbookEditorFixtures,
  playbookEditorStates,
} from "../-visual-metadata";

type PlaybookDetailData = Exclude<
  NonNullable<
    Extract<
      Awaited<ReturnType<ReturnType<typeof api.playbooks>["get"]>>,
      { data: unknown }
    >["data"]
  >,
  Response
>;

const ORGANIZATION_ID = "visual-playbook-organization";
const UPDATED_AT = "2026-10-08T08:00:00.000Z";
const tabId = (state: string) => `visual-playbook-${state}`;

export const PlaybookEditorPlayground = () => {
  const [client] = useState(() => {
    const queryClient = createAppQueryClient();
    queryClient.setDefaultOptions({
      queries: { enabled: false, retry: false, gcTime: Infinity },
    });
    return queryClient;
  });
  const [ready, setReady] = useState(false);

  useMountEffect(() => {
    client.setQueryData(roleOptions.queryKey, "owner");
    client.setQueryData(documentTypesOptions(ORGANIZATION_ID).queryKey, {
      items: [],
    });
    for (const [state, playbookId] of Object.entries(playbookEditorFixtures)) {
      const status = state === "rejected" ? "draft" : "approved";
      const options = playbookDetailOptions(ORGANIZATION_ID, playbookId);
      const detail = {
        id: toSafeId<"playbookDefinition">(playbookId),
        name: "Contract review",
        description: "Saved review instructions",
        scope: null,
        positions: { version: 3, items: [] },
        status,
        approvedAt: status === "approved" ? UPDATED_AT : null,
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        positionDecisions: {},
        positionSources: [],
      } satisfies PlaybookDetailData;
      client.setQueryData(options.queryKey, detail);
      const savedDraft = {
        name: detail.name,
        description: detail.description,
        documentTypeKey: null,
        perspective: null,
        trigger: null,
        positions: [],
      };
      // Seed the real restoration boundary: local edits differ from the cache.
      const parked = {
        playbookId,
        draft: {
          ...savedDraft,
          description: `${state}: retain the negotiated liability cap`,
        },
        baseline: createPlaybookBaseline(savedDraft),
        unacknowledgedDrafts: [],
        updatedAt: UPDATED_AT,
        status,
        approvedAt: detail.approvedAt,
        openIds: new Set<string>(),
        revealedIds: new Set<string>(),
        scrollTop: 0,
        leaveState: state === "rejected" ? "save-failed" : "dirty-unsaveable",
      } satisfies ParkedPlaybookPane;
      parkPlaybookPane({
        tabId: tabId(state),
        state: parked,
        isTabOpen: () => true,
      });
    }
    setReady(true);
    return () => {
      for (const state of playbookEditorStates) {
        discardParkedPlaybookPane(tabId(state));
      }
      client.clear();
    };
  });

  return (
    <QueryClientProvider client={client}>
      <div className="flex flex-col gap-6 p-4">
        {ready &&
          Object.entries(playbookEditorFixtures).map(([state, playbookId]) => (
            <section
              key={state}
              data-playground-section={`playbook-editor:${state}`}
            >
              <h2 className="text-muted-foreground mb-2 text-xs">{state}</h2>
              {/* Static capture: actions cannot send fixture data to the API. */}
              <div inert className="bg-background h-[600px] rounded-lg border">
                <PlaybookEditor
                  organizationId={ORGANIZATION_ID}
                  playbookId={playbookId}
                  host={{
                    type: "pane",
                    tabId: tabId(state),
                    // Unmount discards the bench instead of flushing a save.
                    isTabOpen: () => false,
                    onClose: () => undefined,
                  }}
                />
              </div>
            </section>
          ))}
      </div>
    </QueryClientProvider>
  );
};
