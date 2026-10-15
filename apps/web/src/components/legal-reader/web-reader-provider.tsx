import { useContext } from "react";
import type { ReactNode } from "react";

import { QueryClientContext } from "@tanstack/react-query";
import { panic } from "better-result";

import { DecisionReaderProvider } from "@stll/decision-reader/reader-adapters";
import type { DecisionReaderAdapters } from "@stll/decision-reader/reader-adapters";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import {
  CitedProvisionExpansion,
  CitedProvisionLink,
} from "@/components/legal-reader/cited-provision-link";
import { CitedStatuteLink } from "@/components/legal-reader/cited-statute-link";
import { useWebReaderPresentationAdapters } from "@/components/legal-reader/web-reader-presentation";
import { DecisionBodyUnavailable } from "@/features/case-law/components/case-viewer/decision-body-state";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import { provisionPreviewOptions } from "@/lib/statutes/provision-preview";

export const WebReaderProvider = ({ children }: { children: ReactNode }) => {
  const inspector = useInspectorView();
  const queryClient = useContext(QueryClientContext);
  const adapters = {
    ...useWebReaderPresentationAdapters(),
    renderDecisionLink: (props) => <CitedDecisionLink {...props} />,
    renderStatuteLink: (props) => {
      switch (props.type) {
        case "statute":
          return (
            <CitedStatuteLink target={props.target}>
              {props.children}
            </CitedStatuteLink>
          );
        case "provision":
          return (
            <CitedProvisionLink provision={props.provision}>
              {props.children}
            </CitedProvisionLink>
          );
        case "provision-expansion":
          return <CitedProvisionExpansion citations={props.citations} />;
        default:
          props satisfies never;
          return panic("Unhandled reader statute link");
      }
    },
    renderBodyUnavailable: (props) => <DecisionBodyUnavailable {...props} />,
    openProvision: (provision) =>
      inspector.open(createProvisionViewTab(provision)),
    loadProvisionPreview: async (ref) =>
      await (
        queryClient ?? panic("Reader previews require QueryClientProvider")
      ).query(provisionPreviewOptions(ref)),
  } satisfies DecisionReaderAdapters;

  return (
    <DecisionReaderProvider adapters={adapters}>
      {children}
    </DecisionReaderProvider>
  );
};
