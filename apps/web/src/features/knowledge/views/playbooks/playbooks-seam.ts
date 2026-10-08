import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";

type PlaybookStatus = PlaybookListItem["status"];

/** A ready-made playbook anyone can start from. */
export type KnowledgePlaybookStarter = {
  starterId: string;
  name: string;
  description: string;
  positionCount: number;
};

/** One of a library's own playbooks. */
export type KnowledgePlaybook = {
  id: string;
  name: string;
  description: string | null;
  status: PlaybookStatus;
  /** Shown in place of a missing description when the source knows it. */
  updatedAt?: string | undefined;
};

/** A library playbook with the time it was last used. */
export type KnowledgeRecentPlaybook = {
  id: string;
  name: string;
  status: PlaybookStatus;
  lastUsedAt: string;
};

/** A list that may still be loading. */
type Loadable<Item> = {
  status: "loading" | "ready";
  items: readonly Item[];
};

/** What the playbooks page renders. The route's adapter fills it. */
export type PlaybooksSource = {
  starters: {
    /** `error`: the list could not be read. */
    status: "loading" | "ready" | "error";
    items: readonly KnowledgePlaybookStarter[];
    /** The starter being added right now; every card waits while it is. */
    pendingStarterId: string | null;
    /** Reads the list again after it failed; absent where it cannot fail. */
    retry?: (() => void) | undefined;
  };
  /** A library's recently used playbooks; absent where there is no library. */
  recent?: Loadable<KnowledgeRecentPlaybook> | undefined;
  /** A library's playbooks; absent where there is no library. */
  library?:
    | {
        playbooks: readonly KnowledgePlaybook[];
        hasNextPage: boolean;
        isFetchingNextPage: boolean;
      }
    | undefined;
};

/** Starting a chat that drafts a new playbook with the user. */
export type KnowledgePlaybookBuilder = {
  start: () => void;
  status: "idle" | "starting";
};

/** What the playbooks page can do. The route decides what each one means. */
export type PlaybooksActions = {
  /** Present when the viewer may start from a ready-made playbook. */
  startFrom?: ((starter: KnowledgePlaybookStarter) => void) | undefined;
  /** Present when the viewer may draft a playbook in a chat. */
  buildWithAi?: KnowledgePlaybookBuilder | undefined;
  open: (playbookId: string) => void;
  loadMore: () => void;
  refresh: () => void;
};
