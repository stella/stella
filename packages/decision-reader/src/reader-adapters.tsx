import { createContext, useContext } from "react";
import type { ReactElement, ReactNode } from "react";

import { panic } from "better-result";

import type { ReaderCitationTreatment } from "./citation-treatment";
import type { MissingBodyReason } from "./decision-body-state.logic";
import type {
  CitedDecisionTarget,
  CitedProvisionTarget,
  CitedStatuteTarget,
  ProvisionPreviewData,
  ProvisionViewPayload,
} from "./reader-types";

export type ReaderMessageKey =
  | "statutes.diffRemoved"
  | "statutes.diffInserted"
  | "common.copyLink"
  | "common.back"
  | "caseLaw.viewer.legalSentence"
  | "caseLaw.viewer.abstract"
  | "folio.comment"
  | "legalReader.annotations.highlight"
  | "caseLaw.reader.headMatter"
  | "caseLaw.notesFilter.ai"
  | "common.court"
  | "statutes.currentWording"
  | "statutes.wordingVersionUnknown"
  | "statutes.openProvision";

export type ReaderMessages = Record<ReaderMessageKey, string> & {
  sourceAttribution: (
    source: string,
    link: (children: ReactNode) => ReactNode,
  ) => ReactNode;
  dissentByline: (names: readonly string[]) => ReactNode;
  wordingValidFrom: (date: string) => string;
  formatValidityDate: (date: string | null) => string | null;
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
      label: string;
      provision: CitedProvisionTarget;
      version: ProvisionWordingVersion;
    };

export type ProvisionWordingVersion =
  | { type: "current" }
  | { type: "consolidation"; validFrom: string | null };

export type ProvisionPreviewRef = {
  anchor: string;
  citedAnchor: string | undefined;
  documentId: string;
};

export type ReaderPresentationAdapters = {
  messages: ReaderMessages;
  copyPermalink: (anchorId: string) => void;
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
