import type { QueryClient } from "@tanstack/react-query";

import { useMountEffect } from "@/hooks/use-effect";
import { loadClientDocumentPresentation } from "@/i18n/document-presentation";
import { getTranslator } from "@/i18n/translator";
import { detachedUserAction } from "@/lib/errors/user-toast";

/** Start account presentation only after the root route joins the client tree. */
export const ClientDocumentPresentationBoot = ({
  queryClient,
}: {
  queryClient: QueryClient;
}) => {
  useMountEffect(() => {
    detachedUserAction(loadClientDocumentPresentation(queryClient), {
      context: "document-presentation.boot",
      failureMessage: getTranslator()("errors.actionFailed"),
    });
  });
  return null;
};
