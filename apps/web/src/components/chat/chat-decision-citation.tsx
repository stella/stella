import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { useQueries, useQuery } from "@tanstack/react-query";
import type { QueryFunctionContext } from "@tanstack/react-query";
import { panic } from "better-result";

import { createCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";

import {
  openCaseLawDecision,
  openReadCaseLawDecision,
} from "@/components/chat/case-law-open";
import { chatAppOrigins } from "@/components/chat/chat-app-origins";
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
import { CitationChip } from "@/components/references/citation-chip";
import { inlineDecisionCitationPresentation } from "@/components/references/decision-citation-chip.logic";
import type { CitedDecisionParagraph } from "@/components/references/reference.logic";
import { env } from "@/env";
import { publicCaseLawPageCountryFromParam } from "@/features/case-law/case-law-jurisdiction";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";

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
};
type CommonCitationProps = {
  passage?: ReactNode;
  /** The block the citation points into, as the answer's link names it. */
  paragraph?: CitedDecisionParagraph | undefined;
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
  paragraph,
  renderPassage = true,
  onOpen,
}: CommonCitationProps & {
  read: DecisionCitationRead;
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
    readerUrl: withAnchor(readerUrl ?? metadata.readerUrl, paragraph?.anchorId),
    originalUrl: originalUrl === undefined ? metadata.originalUrl : originalUrl,
  };
  const presentation = inlineDecisionCitationPresentation(
    passage,
    metadata.caseNumber,
  );
  if (renderPassage && presentation.kind === "chip-replaces-text") {
    return (
      <>
        {presentation.before}
        <CitationChip
          kind="decision"
          decision={decision}
          onOpenInSidePanel={onOpen}
          presentation="inline"
          paragraphNumber={paragraph?.courtParagraphNumber ?? null}
        />
        {presentation.after}
        <CitationReadFeedback read={read} />
      </>
    );
  }
  return (
    <>
      {renderPassage ? (
        <>
          {presentation.kind === "chip-after-text"
            ? presentation.label
            : passage}{" "}
          <CitationChip
            kind="decision"
            decision={decision}
            onOpenInSidePanel={onOpen}
            presentation="inline"
            paragraphNumber={paragraph?.courtParagraphNumber ?? null}
          />
        </>
      ) : (
        <CitationChip
          kind="decision"
          decision={decision}
          passage={passage}
          paragraphNumber={paragraph?.courtParagraphNumber ?? null}
          onOpenInSidePanel={onOpen}
        />
      )}
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
  const view = queryView(
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
      onOpen={() =>
        detached(
          view.type === "items"
            ? openReadCaseLawDecision(view.items, open, {
                anchorId: props.paragraph?.anchorId,
              })
            : openCaseLawDecision({ type: "ref", ref: decisionId }, open, {
                anchorId: props.paragraph?.anchorId,
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
  const view = queryView(
    useQuery({ ...options, enabled: scopedRead?.type !== "source" }),
  );
  const { open } = useOpenDecisionTab();
  return (
    <CitationView
      {...props}
      read={
        scopedRead?.type === "source" ? scopedRead : { type: "query", view }
      }
      onOpen={() =>
        detached(
          view.type === "items"
            ? openReadCaseLawDecision(view.items, open, {
                anchorId: props.paragraph?.anchorId,
              })
            : openCaseLawDecision({ type: "route", params }, open, {
                anchorId: props.paragraph?.anchorId,
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
  const appOrigins = chatAppOrigins();
  const { uniqueExternalSources } = collectSourceChipEntries({
    appOrigins,
    parts: message.parts,
  });
  const sources = [...uniqueExternalSources, ...Object.values(storedSources)];
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
        const country = publicCaseLawPageCountryFromParam(
          target.params.country,
        );
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
    // Adapt both key shapes to one fetcher signature rather than distributing
    // queryOptions' optional generic callbacks through the dynamic array.
    queries: requests.map((request) => ({
      queryKey: request.options.queryKey,
      queryFn: async (context: QueryFunctionContext) => {
        switch (request.type) {
          case "id":
            return (
              request.options.queryFn ??
              panic("Decision id options must provide a fetcher")
            )({ ...context, queryKey: request.options.queryKey });
          case "route":
            return (
              request.options.queryFn ??
              panic("Decision slug options must provide a fetcher")
            )({ ...context, queryKey: request.options.queryKey });
          default:
            request satisfies never;
            return panic("Unhandled citation cache request");
        }
      },
      staleTime: ROUTE_QUERY_STALE_TIME_MS,
      enabled: false,
    })),
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
  return (
    <AnswerDecisionContext value={{ reads, routes }}>
      {children}
    </AnswerDecisionContext>
  );
};

/**
 * The decisions this answer cites by id, as their readers load them (full
 * text and blocks), for checking its quotations against. The same cache
 * entries the citation chips read, so a quotation adds no request of its own;
 * outside an answer there are none.
 */
export const useAnswerCitedDecisions = (): PublicCaseLawDecision[] => {
  const answer = useContext(AnswerDecisionContext);
  if (answer === null) {
    return [];
  }
  // Decisions cited by id or by route, as the answer already read them. A
  // decision still loading, or failed, leaves its quotations unverified
  // rather than wrong; its citation chip already reports a failed read.
  const decisions = new Map<string, PublicCaseLawDecision>();
  for (const read of [...answer.reads.values(), ...answer.routes.values()]) {
    if (read.type === "query" && read.view.type === "items") {
      decisions.set(read.view.items.id, read.view.items);
    }
  }
  return [...decisions.values()];
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
  const country = publicCaseLawPageCountryFromParam(params.country);
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
