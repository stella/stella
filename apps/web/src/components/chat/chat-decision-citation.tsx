import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { createCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import { CitationReadFeedback } from "@/components/chat/chat-decision-citation-feedback";
import {
  readyCitationMetadata,
  sourceCitationMetadata,
} from "@/components/chat/chat-decision-citation-metadata.logic";
import type { DecisionCitationRead } from "@/components/chat/chat-decision-citation-metadata.logic";
import {
  chatAnswerDecisionTargets,
  chatAnswerMarkdownDocuments,
} from "@/components/chat/chat-decision-citations.logic";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { collectSourceChipEntries } from "@/components/chat/source-chips.logic";
import { DecisionCitationChip } from "@/components/references/decision-citation-chip";
import { decisionCitationPresentationsById } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import { env } from "@/env";
import { publicCaseLawCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { useQueryView } from "@/lib/use-query-view";

type CitationCacheRequest =
  | { type: "id"; key: string; options: ReturnType<typeof decisionOptions> }
  | {
      type: "route";
      key: string;
      options: ReturnType<typeof decisionBySlugOptions>;
    };

type AnswerDecisionContextValue = {
  reads: ReadonlyMap<string, DecisionCitationRead>;
  routes: ReadonlyMap<string, DecisionCitationRead>;
  presentations: ReadonlyMap<string, DecisionCitationPresentation>;
};
type CommonCitationProps = {
  passage?: ReactNode;
  anchorId?: string | undefined;
  readerUrl?: string | undefined;
  originalUrl?: string | null | undefined;
  interactive: boolean;
  renderPassage?: boolean | undefined;
};
type ChatDecisionCitationProps = CommonCitationProps & { decisionId: string };
type ChatRouteDecisionCitationProps = CommonCitationProps & {
  params: CaseLawDecisionRouteParams;
};

const AnswerDecisionContext = createContext<AnswerDecisionContextValue | null>(
  null,
);

// Native navigation (modifier click, middle click, copied link) follows the
// href, so the cited paragraph has to live in the URL, not only in onOpen.
const withAnchor = (href: string, anchorId: string | undefined): string => {
  if (anchorId === undefined) {
    return href;
  }
  const hashIndex = href.indexOf("#");
  const base = hashIndex === -1 ? href : href.slice(0, hashIndex);
  return `${base}#${encodeURIComponent(anchorId)}`;
};

const CitationView = ({
  read,
  passage,
  readerUrl,
  originalUrl,
  anchorId,
  renderPassage = true,
  presentationById,
  onOpen,
}: CommonCitationProps & {
  read: DecisionCitationRead;
  presentationById: AnswerDecisionContextValue["presentations"] | undefined;
  onOpen: () => void;
}) => {
  const metadata = readyCitationMetadata(read);
  if (metadata === null) {
    return (
      <>
        {renderPassage && passage}
        <CitationReadFeedback read={read} />
      </>
    );
  }
  const decision = {
    ...metadata,
    readerUrl: withAnchor(readerUrl ?? metadata.readerUrl, anchorId),
    originalUrl: originalUrl === undefined ? metadata.originalUrl : originalUrl,
  };
  return (
    <>
      {renderPassage && passage}
      <span className="ms-1">
        <DecisionCitationChip
          decision={decision}
          passage={passage}
          presentation={presentationById?.get(metadata.decisionId) ?? "compact"}
          onOpen={onOpen}
        />
      </span>
      <CitationReadFeedback read={read} />
    </>
  );
};

const ActiveChatDecisionCitation = ({
  decisionId,
  ...props
}: ChatDecisionCitationProps) => {
  const answer = useContext(AnswerDecisionContext);
  const scopedRead = answer?.reads.get(decisionId);
  const view = useQueryView(
    useQuery({
      ...decisionOptions(decisionId),
      enabled: scopedRead?.type !== "source",
    }),
  );
  const { open } = useOpenDecisionTab();
  return (
    <CitationView
      {...props}
      read={
        scopedRead?.type === "source" ? scopedRead : { type: "query", view }
      }
      presentationById={answer?.presentations}
      onOpen={() =>
        detached(
          openCaseLawDecision({ type: "ref", ref: decisionId }, open, {
            anchorId: props.anchorId,
          }),
          "chat-decision-citation.open",
        )
      }
    />
  );
};

const ActiveChatRouteDecisionCitation = ({
  params,
  options,
  ...props
}: ChatRouteDecisionCitationProps & {
  options: ReturnType<typeof decisionBySlugOptions>;
}) => {
  const answer = useContext(AnswerDecisionContext);
  const scopedRead = answer?.routes.get(createCaseLawDecisionPath(params));
  const view = useQueryView(
    useQuery({ ...options, enabled: scopedRead?.type !== "source" }),
  );
  const { open } = useOpenDecisionTab();
  return (
    <CitationView
      {...props}
      read={
        scopedRead?.type === "source" ? scopedRead : { type: "query", view }
      }
      presentationById={answer?.presentations}
      onOpen={() =>
        detached(
          openCaseLawDecision({ type: "route", params }, open, {
            anchorId: props.anchorId,
          }),
          "chat-decision-citation.open-route",
        )
      }
    />
  );
};

/** Observes the rendered answer's query cache; only active citation adapters schedule reads. */
export const ChatAnswerDecisionProvider = ({
  message,
  isAwaitingUser,
  children,
}: {
  message: ChatUIMessage;
  isAwaitingUser: boolean;
  children: ReactNode;
}) => {
  const storedSources = useExternalSourceStore((state) => state.sourcesByUrl);
  const { uniqueExternalSources } = collectSourceChipEntries({
    parts: message.parts,
  });
  const sources = [...uniqueExternalSources, ...Object.values(storedSources)];
  const appOrigins = new Set([
    new URL(env.VITE_PUBLIC_APP_URL).origin,
    ...(typeof window === "undefined" ? [] : [window.location.origin]),
  ]);
  const targets = chatAnswerDecisionTargets({
    markdownDocuments: chatAnswerMarkdownDocuments(message, isAwaitingUser),
    sources,
    appOrigins,
  });
  const reads = new Map<string, DecisionCitationRead>();
  const routes = new Map<string, DecisionCitationRead>();
  for (const source of sources) {
    const id = source.caseLawDecision?.decisionId;
    if (id === undefined || reads.has(id)) {
      continue;
    }
    const metadata = sourceCitationMetadata({
      decisionId: id,
      sources,
      appOrigins,
    });
    if (metadata !== null) {
      const read = {
        type: "source",
        metadata,
      } as const satisfies DecisionCitationRead;
      reads.set(id, read);
      routes.set(
        new URL(metadata.readerUrl, env.VITE_PUBLIC_APP_URL).pathname,
        read,
      );
    }
  }
  const requests: CitationCacheRequest[] = [];
  for (const target of targets) {
    switch (target.type) {
      case "id":
        if (!reads.has(target.decisionId)) {
          requests.push({
            key: target.decisionId,
            type: "id",
            options: decisionOptions(target.decisionId),
          });
        }
        break;
      case "route": {
        const key = createCaseLawDecisionPath(target.params);
        const country = publicCaseLawCountryFromParam(target.params.country);
        if (!routes.has(key) && country !== null) {
          requests.push({
            key,
            type: "route",
            options: decisionBySlugOptions({
              country,
              slug: target.params.slug,
              ...(target.params.language === undefined
                ? {}
                : { language: target.params.language }),
            }),
          });
        }
        break;
      }
      default:
        target satisfies never;
        panic("Unhandled answer citation target");
    }
  }
  const queries = useQueries({
    queries: requests.map(({ options }) => ({ ...options, enabled: false })),
  });
  for (const [index, request] of requests.entries()) {
    const query = queries.at(index);
    if (query === undefined) {
      return panic("Every citation must have a cache observer");
    }
    const read = {
      type: "query",
      view: queryView(query),
    } as const satisfies DecisionCitationRead;
    if (request.type === "id") {
      reads.set(request.key, read);
    } else {
      routes.set(request.key, read);
    }
  }
  const decisions = targets.flatMap((target) => {
    const read =
      target.type === "id"
        ? reads.get(target.decisionId)
        : routes.get(createCaseLawDecisionPath(target.params));
    const metadata = read === undefined ? null : readyCitationMetadata(read);
    return metadata === null ? [] : [metadata];
  });
  const presentations = decisionCitationPresentationsById(decisions);
  return (
    <AnswerDecisionContext value={{ reads, routes, presentations }}>
      {children}
    </AnswerDecisionContext>
  );
};

/** A quotation remains prose; its decision annotation owns metadata and actions. */
// Explicit ReactNode: returning the bare passage infers a type containing
// React 19's Promise<AwaitedReactNode> member, which promise-function-async
// would otherwise flag on this sync component.
export const ChatDecisionCitation = (
  props: ChatDecisionCitationProps,
): ReactNode => {
  if (!props.interactive) {
    return props.renderPassage !== false && props.passage;
  }
  return <ActiveChatDecisionCitation {...props} />;
};

/** Slug identity is resolved by the canonical public read, never synthesized from the URL. */
export const ChatRouteDecisionCitation = ({
  params,
  ...props
}: ChatRouteDecisionCitationProps): ReactNode => {
  const country = publicCaseLawCountryFromParam(params.country);
  if (!props.interactive || country === null) {
    return props.renderPassage !== false && props.passage;
  }
  return (
    <ActiveChatRouteDecisionCitation
      {...props}
      params={params}
      options={decisionBySlugOptions({
        country,
        slug: params.slug,
        ...(params.language === undefined ? {} : { language: params.language }),
      })}
    />
  );
};
