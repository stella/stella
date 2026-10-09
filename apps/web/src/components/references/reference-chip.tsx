import type { ReactNode } from "react";
import { createContext, Fragment, isValidElement, use } from "react";

import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { panic } from "better-result";

import { LandmarkIcon, SkillIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { openCaseLawDecision } from "@/components/chat/case-law-open";
import { openEntityInInspector } from "@/components/chat/entity-open";
import { skillRefDestination } from "@/components/chat/skill-ref-link";
import { InlinePill } from "@/components/inline-pill";
import { MatterIcon } from "@/components/matter-icon";
import { referenceHintOptions } from "@/components/references/reference-hints";
import {
  referenceFromHref,
  referenceMatterId,
  resolveReferenceVisual,
} from "@/components/references/reference.logic";
import type {
  ChatReference,
  LiveFact,
  ReferenceGlyph,
  ReferenceLiveFacts,
  ReferenceMatterColor,
  ReferenceVisual,
} from "@/components/references/reference.logic";
import { UserIdentityAvatar } from "@/components/user-avatar";
import { EntityIcon } from "@/components/workspaces/entity-kind-icon";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { resolveMatterColor } from "@/lib/matter-colors";
import { organizationOptions } from "@/lib/organization/queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { entityOptions } from "@/lib/workspaces/queries/entities";
import { navigateToWorkspaceFolder } from "@/lib/workspaces/reveal-navigation";

/**
 * The matter a chat surface renders in. An entity href persisted without its
 * matter (a mention from the thread's own matter) resolves against it.
 */
const ReferenceRenderContext = createContext<{
  workspaceId: string | undefined;
}>({ workspaceId: undefined });

export const ReferenceRenderScope = ({
  children,
  workspaceId,
}: {
  children: ReactNode;
  workspaceId: string | undefined;
}) => (
  <ReferenceRenderContext value={{ workspaceId }}>
    {children}
  </ReferenceRenderContext>
);

export const useReferenceRenderWorkspaceId = (): string | undefined =>
  use(ReferenceRenderContext).workspaceId;

const GLYPH_CLASS = "size-3 shrink-0";

const toLiveFact = <TData, TValue>(
  query: { data: TData | undefined; isError: boolean; isPending: boolean },
  enabled: boolean,
  select: (data: TData) => TValue | null,
): LiveFact<TValue> => {
  if (!enabled || query.isError) {
    return { status: "missing" };
  }
  if (query.data === undefined) {
    return query.isPending ? { status: "pending" } : { status: "missing" };
  }
  const value = select(query.data);
  return value === null ? { status: "missing" } : { status: "resolved", value };
};

/**
 * Background reads that refresh what a reference's source carried. Every
 * chip of the same entity, matter or person reads the same cache entry, so a
 * reference looks the same while streaming, after the stream ends, and after
 * a reload.
 */
const useReferenceFacts = (reference: ChatReference): ReferenceLiveFacts => {
  const user = useMaybeAuthenticatedUser();
  const organizationId = user?.activeOrganizationId;
  const entity =
    reference.type === "entity" && reference.matterId !== null
      ? { entityId: reference.entityId, matterId: reference.matterId }
      : null;
  const matterId = referenceMatterId(reference);
  const userId = reference.type === "user" ? reference.userId : null;

  // staleTime Infinity: one read per entity; later chips and the click
  // handler share it, so a thread full of mentions stays cheap.
  const entityQuery = useQuery({
    ...(entity === null
      ? {
          queryKey: ["chat-reference-entity-disabled"] as const,
          queryFn: skipToken,
        }
      : entityOptions(entity.matterId, entity.entityId)),
    enabled: entity !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const hintQuery = useQuery(
    referenceHintOptions(
      reference.type === "entity" ? reference.entityId : null,
    ),
  );
  const hintQueryView = useQueryView(hintQuery);
  useQueryViewError(hintQueryView);
  // The navigation list is already in flight on every chat surface, so the
  // matter colour is a cache read rather than a fetch.
  const mattersQuery = useQuery({
    ...workspacesNavigationOptions({
      organizationId: organizationId ?? "",
      userId: user?.id ?? SIGNED_OUT_QUERY_OWNER,
    }),
    enabled: matterId !== null && organizationId !== undefined,
  });
  const organizationQuery = useQuery({
    ...organizationOptions(organizationId ?? ""),
    enabled: userId !== null && organizationId !== undefined,
  });

  return {
    entity: toLiveFact(entityQuery, entity !== null, (data) => {
      for (const field of data.fields) {
        if (
          field.content.type === "file" &&
          field.content.mimeType.length > 0
        ) {
          return {
            kind: data.kind,
            fileName: field.content.fileName,
            mimeType: field.content.mimeType,
          };
        }
      }
      return { kind: data.kind, fileName: null, mimeType: null };
    }),
    hint:
      reference.type === "entity" && hintQueryView.type === "items"
        ? hintQueryView.items
        : null,
    matter: toLiveFact(
      mattersQuery,
      matterId !== null && organizationId !== undefined,
      (data) => {
        const matter = data.workspaces.find((item) => item.id === matterId);
        return matter === undefined ? null : { color: matter.color };
      },
    ),
    user: toLiveFact(
      organizationQuery,
      userId !== null && organizationId !== undefined,
      (data) => {
        // The organization lists active members only, so a listed person is
        // never a deleted account.
        const member = data.members.find((item) => item.userId === userId);
        return member === undefined
          ? null
          : {
              name: member.user.name,
              image: member.user.image ?? null,
              deleted: false,
            };
      },
    ),
  };
};

const matterCssColor = (matter: ReferenceMatterColor): string | undefined => {
  switch (matter.type) {
    case "none":
    case "pending":
      return undefined;
    case "resolved":
      return resolveMatterColor(matter.matterId, matter.color);
    default:
      matter satisfies never;
      return panic(`Unhandled matter colour: ${String(matter)}`);
  }
};

const ReferenceGlyphIcon = ({
  glyph,
  matter,
}: {
  glyph: ReferenceGlyph;
  matter: ReferenceMatterColor;
}) => {
  switch (glyph.type) {
    case "entity":
      // The wrapper carries the matter colour; a monochrome kind glyph
      // inherits it, a file type's brand mark keeps its own colours.
      return (
        <span
          className="inline-flex shrink-0"
          style={{ color: matterCssColor(matter) }}
        >
          <EntityIcon className={GLYPH_CLASS} source={glyph.source} />
        </span>
      );
    case "matter":
      return matter.type === "resolved" ? (
        <MatterIcon
          className={GLYPH_CLASS}
          matter={{ id: matter.matterId, color: matter.color }}
        />
      ) : (
        <MatterIcon
          className={cn(GLYPH_CLASS, "text-muted-foreground")}
          variant="none"
        />
      );
    case "decision":
      return <LandmarkIcon className={GLYPH_CLASS} />;
    case "skill":
      return <SkillIcon className={GLYPH_CLASS} />;
    case "user":
      return (
        <UserIdentityAvatar
          className="text-3xs size-4 shrink-0"
          deleted={glyph.deleted}
          image={glyph.image}
          name={glyph.name}
        />
      );
    default:
      glyph satisfies never;
      return panic(`Unhandled reference glyph: ${String(glyph)}`);
  }
};

type ReferenceChipViewProps = {
  visual: ReferenceVisual;
  /** Rendered label when the source's label is richer than plain text (a
   * restored anonymized name inside an answer's link). */
  labelContent?: ReactNode;
  onActivate?: (() => void) | undefined;
  selected?: boolean | undefined;
  referenceType: ChatReference["type"];
};

const ReferenceChipView = ({
  visual,
  labelContent,
  onActivate,
  selected = false,
  referenceType,
}: ReferenceChipViewProps) => {
  // `bdi`: a Latin file name or docket inside RTL prose keeps its own order.
  const label = <bdi>{labelContent ?? visual.label}</bdi>;
  if (visual.type === "plain") {
    return <span>{label}</span>;
  }
  return (
    <InlinePill
      className={cn(selected && "ring-ring ring-1")}
      data-reference-type={referenceType}
      leadingIcon={
        <ReferenceGlyphIcon glyph={visual.glyph} matter={visual.matter} />
      }
      onActivate={onActivate}
      truncate
    >
      {label}
    </InlinePill>
  );
};

/**
 * What clicking a reference does, for a control that lists references in its
 * own shell (the open chat's file list) and must open them as a chip does.
 */
export const useReferenceActivation = (reference: ChatReference) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { open: openDecision } = useOpenDecisionTab();

  switch (reference.type) {
    case "entity": {
      const { entityId, label, matterId } = reference;
      if (matterId === null) {
        return undefined;
      }
      return () =>
        detached(
          (async () => {
            const result = await openEntityInInspector(
              entityId,
              label,
              matterId,
            );
            if (result.type === "folder") {
              await navigateToWorkspaceFolder({
                folderId: result.entityId,
                navigate,
                pathname,
                queryClient,
                targetWorkspaceId: result.workspaceId,
              });
            }
          })(),
          "reference-chip.open-entity",
        );
    }
    case "matter":
      return () =>
        detached(
          navigate({
            to: "/workspaces/$workspaceId",
            params: { workspaceId: reference.matterId },
          }),
          "reference-chip.open-matter",
        );
    case "decision":
      return () =>
        detached(
          openCaseLawDecision(
            reference.locator,
            openDecision,
            reference.anchorId === null ? {} : { anchorId: reference.anchorId },
          ),
          "reference-chip.open-decision",
        );
    case "skill":
      return () =>
        detached(
          navigate(skillRefDestination(reference.slug)),
          "reference-chip.open-skill",
        );
    case "user":
      return undefined;
    default:
      reference satisfies never;
      return panic(`Unhandled reference: ${String(reference)}`);
  }
};

type ReferenceChipProps = {
  reference: ChatReference;
  labelContent?: ReactNode;
  selected?: boolean | undefined;
};

const StaticReferenceChip = ({
  reference,
  labelContent,
  selected,
}: ReferenceChipProps) => {
  const facts = useReferenceFacts(reference);
  return (
    <ReferenceChipView
      labelContent={labelContent}
      referenceType={reference.type}
      selected={selected}
      visual={resolveReferenceVisual(reference, facts)}
    />
  );
};

const InteractiveReferenceChip = ({
  reference,
  labelContent,
  selected,
}: ReferenceChipProps) => {
  const facts = useReferenceFacts(reference);
  const onActivate = useReferenceActivation(reference);
  return (
    <ReferenceChipView
      labelContent={labelContent}
      onActivate={onActivate}
      referenceType={reference.type}
      selected={selected}
      visual={resolveReferenceVisual(reference, facts)}
    />
  );
};

/**
 * The one presentation of a chat reference. The composer node view, the sent
 * user message, the assistant's markdown, the ask-user card and the
 * streaming-fallback skill chip all render a reference through here, so none
 * of them can drift.
 *
 * The visual rule: the glyph says what the reference is (the kind's icon, a
 * person's avatar); a reference that lives in a matter paints that glyph in
 * the matter's colour, on the icon only, never as a fill or border. A file
 * type's brand mark keeps its own colours. The composer's node selection is a
 * ring, a state style. The label truncates the same way everywhere.
 */
export const ReferenceChip = ({
  interactive,
  ...props
}: ReferenceChipProps & { interactive: boolean }) =>
  interactive ? (
    <InteractiveReferenceChip {...props} />
  ) : (
    <StaticReferenceChip {...props} />
  );

/**
 * A reference's glyph alone, by the same rule as the chip, for a control that
 * lists references in its own shell (the sources tray under an answer).
 */
export const ReferenceIcon = ({ reference }: { reference: ChatReference }) => {
  const facts = useReferenceFacts(reference);
  const visual = resolveReferenceVisual(reference, facts);
  return visual.type === "chip" ? (
    <ReferenceGlyphIcon glyph={visual.glyph} matter={visual.matter} />
  ) : null;
};

const isReactNodeArray = (node: ReactNode): node is readonly ReactNode[] =>
  Array.isArray(node);

const plainText = (node: ReactNode): string | null => {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (isReactNodeArray(node)) {
    const parts: string[] = [];
    for (const child of node) {
      const text = plainText(child);
      if (text === null) {
        return null;
      }
      parts.push(text);
    }
    return parts.join("");
  }
  if (
    isValidElement<{ children?: ReactNode }>(node) &&
    node.type === Fragment
  ) {
    return plainText(node.props.children);
  }
  return null;
};

/**
 * A reference link in rendered markdown (an answer, a sent message, an
 * ask-user card). Returns null when the href is not a reference, so the caller
 * renders its own link; an href the server marked unresolvable renders as its
 * plain label.
 */
export const MarkdownReferenceChip = ({
  href,
  children,
  interactive,
  workspaceId,
}: {
  href: string;
  children: ReactNode;
  interactive: boolean;
  workspaceId?: string | undefined;
}) => {
  const renderWorkspaceId = useReferenceRenderWorkspaceId();
  const text = plainText(children);
  const parsed = referenceFromHref(href, text ?? "", {
    renderWorkspaceId: workspaceId ?? renderWorkspaceId,
  });
  if (parsed === null) {
    return null;
  }
  if (parsed.type === "unresolved") {
    return <span>{children}</span>;
  }
  return (
    <ReferenceChip
      interactive={interactive}
      // Rich link text (a restored anonymized name) renders as written; plain
      // text goes through the reference's own label rules.
      labelContent={text === null ? children : undefined}
      reference={parsed.reference}
    />
  );
};
