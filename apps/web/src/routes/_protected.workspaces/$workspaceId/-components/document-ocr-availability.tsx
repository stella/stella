import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useQuery } from "@tanstack/react-query";

import { documentOcrAvailabilityOptions } from "@/queries/document-ocr-availability";

const DocumentOcrAvailabilityContext = createContext(false);

type DocumentOcrAvailabilityProviderProps = PropsWithChildren<{
  organizationId: string;
}>;

// One workspace-view observer owns the readiness refresh. Row action menus
// consume this value rather than each creating their own polling observer.
export const DocumentOcrAvailabilityProvider = ({
  organizationId,
  children,
}: DocumentOcrAvailabilityProviderProps) => {
  const { data } = useQuery(documentOcrAvailabilityOptions({ organizationId }));

  return (
    <DocumentOcrAvailabilityContext value={data?.available === true}>
      {children}
    </DocumentOcrAvailabilityContext>
  );
};

export const useDocumentOcrAvailability = () =>
  use(DocumentOcrAvailabilityContext);
