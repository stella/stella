import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { api } from "@/lib/api";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

type MentionProviders = {
  getItems: (categories: MentionCategory[]) => ChatMentionOption[];
};

const MentionProvidersContext = createContext<MentionProviders>({
  getItems: () => [],
});

export const useMentionProviders = () => useContext(MentionProvidersContext);

const contactsMentionOptions = {
  queryKey: ["mentions", "contacts"],
  queryFn: async () => {
    const res = await api.contacts.get({
      query: { limit: 30 },
    });
    if (res.error) {
      return [];
    }
    return res.data.items.map(
      (c): ChatMentionOption => ({
        id: c.id,
        label: c.displayName,
        category: "contact",
        kind: c.type,
        mimeType: null,
      }),
    );
  },
  staleTime: 60_000,
};

const templatesMentionOptions = {
  queryKey: ["mentions", "templates"],
  queryFn: async () => {
    const res = await api.templates.get();
    if (res.error) {
      return [];
    }
    return res.data.templates.map(
      (t): ChatMentionOption => ({
        id: t.id,
        label: t.name,
        category: "template" as const,
        kind: "template",
        mimeType: null,
      }),
    );
  },
  staleTime: 60_000,
};

const clausesMentionOptions = {
  queryKey: ["mentions", "clauses"],
  queryFn: async () => {
    const res = await api.clauses.get({
      query: { limit: 50 },
    });
    if (res.error) {
      return [];
    }
    return res.data.clauses.map(
      (c): ChatMentionOption => ({
        id: c.id,
        label: c.title,
        category: "clause" as const,
        kind: "clause",
        mimeType: null,
      }),
    );
  },
  staleTime: 60_000,
};

/** Provides org-level mention sources (workspaces, contacts,
 *  templates, clauses) to any ChatEditor below. */
export const ChatMentionProviders = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { data: workspacesData } = useQuery(workspacesOptions);
  const { data: contacts } = useQuery(contactsMentionOptions);
  const { data: templates } = useQuery(templatesMentionOptions);
  const { data: clauses } = useQuery(clausesMentionOptions);

  const workspaces = workspacesData?.workspaces;

  const value = useMemo<MentionProviders>(() => {
    return {
      getItems: (categories) => {
        const items: ChatMentionOption[] = [];

        if (categories.includes("workspace") && workspaces) {
          for (const ws of workspaces) {
            items.push({
              id: ws.id,
              label: ws.name,
              category: "workspace",
              kind: "workspace",
              mimeType: null,
            });
          }
        }

        if (categories.includes("contact") && contacts) {
          items.push(...contacts);
        }

        if (categories.includes("template") && templates) {
          items.push(...templates);
        }

        if (categories.includes("clause") && clauses) {
          items.push(...clauses);
        }

        return items;
      },
    };
  }, [workspaces, contacts, templates, clauses]);

  return (
    <MentionProvidersContext value={value}>{children}</MentionProvidersContext>
  );
};
