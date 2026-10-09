import { createContext, useContext } from "react";
import type { ReactElement, ReactNode } from "react";

import { panic } from "better-result";

import type { ReaderCitationTreatment } from "./citation-treatment";
import type { MissingBodyReason } from "./decision-body-state.logic";
import type { ReaderMessageKey } from "./reader-message-types";
import type {
  CitedDecisionTarget,
  CitedProvisionTarget,
  CitedStatuteTarget,
  ProvisionPreviewData,
  ProvisionViewPayload,
} from "./reader-types";

export type { ReaderMessageKey } from "./reader-message-types";

export type ReaderMessages = Record<ReaderMessageKey, string> & {
  sourceAttribution: (
    source: string,
    link: (children: ReactNode) => ReactNode,
  ) => ReactNode;
  dissentByline: (names: readonly string[]) => ReactNode;
  provisionEffectiveFrom: (date: string) => string;
  formatValidityDate: (date: string | null) => string | null;
  /** The cited act by number and title, e.g. `89/2012 Sb., Občanský zákoník`. */
  provisionActText: (provision: ProvisionViewPayload) => string;
  /** Labels joined the way the reader's language lists them, abbreviated. */
  formatLabelList: (labels: readonly string[]) => string;
};

export type ReaderDecisionLinkProps = {
  children: ReactNode;
  className?: string | undefined;
  decision: CitedDecisionTarget;
  treatment: ReaderCitationTreatment;
};

export type ReaderStatuteLinkProps =
  | { type: "statute"; children: ReactNode; target: CitedStatuteTarget }
  | { type: "provision"; children: ReactNode; provision: CitedProvisionTarget }
  | {
      type: "provision-expansion";
      /** The citations of one provision in one paragraph, sharing a card. */
      citations: readonly CitedProvisionTarget[];
    };

export type ProvisionPreviewRef = {
  anchor: string;
  citedAnchor: string | undefined;
  documentId: string;
};

export type ReaderPresentationAdapters = {
  messages: ReaderMessages;
  /** Omit when the host cannot copy a permalink; copy controls are hidden. */
  copyPermalink?: ((anchorId: string) => void) | undefined;
};

export type DecisionReaderAdapters = ReaderPresentationAdapters & {
  renderDecisionLink: (props: ReaderDecisionLinkProps) => ReactElement;
  renderStatuteLink: (props: ReaderStatuteLinkProps) => ReactElement;
  renderBodyUnavailable: (props: {
    decisionId: string;
    reason: MissingBodyReason;
  }) => ReactNode;
  openProvision: (provision: ProvisionViewPayload) => void;
  loadProvisionPreview: (
    ref: ProvisionPreviewRef,
  ) => Promise<ProvisionPreviewData>;
};

const ReaderPresentationContext =
  createContext<ReaderPresentationAdapters | null>(null);

export const ReaderPresentationProvider = ({
  adapters,
  children,
}: {
  adapters: ReaderPresentationAdapters;
  children: ReactNode;
}) => (
  <ReaderPresentationContext value={adapters}>
    {children}
  </ReaderPresentationContext>
);

export const useReaderPresentation = (): ReaderPresentationAdapters =>
  useContext(ReaderPresentationContext) ??
  panic("ReaderPresentationProvider is required");

const ReaderAdaptersContext = createContext<DecisionReaderAdapters | null>(
  null,
);

export const DecisionReaderProvider = ({
  adapters,
  children,
}: {
  adapters: DecisionReaderAdapters;
  children: ReactNode;
}) => (
  <ReaderPresentationProvider adapters={adapters}>
    <ReaderAdaptersContext value={adapters}>{children}</ReaderAdaptersContext>
  </ReaderPresentationProvider>
);

export const useReaderAdapters = (): DecisionReaderAdapters =>
  useContext(ReaderAdaptersContext) ??
  panic("DecisionReaderProvider is required");

export const useReaderMessages = (): ReaderMessages =>
  useReaderPresentation().messages;
