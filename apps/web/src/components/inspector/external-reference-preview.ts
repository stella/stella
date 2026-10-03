import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { BoundedSet } from "@/lib/bounded-set";
import { toAPIError, unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";

const SERVER_PREVIEW_ERROR_THRESHOLD = 500;
const toastedPreviewFailures = new BoundedSet<string>(100);

type ExternalReferencePreviewOptions = {
  url: string;
  errorTitle: string;
};

export const externalReferencePreviewOptions = ({
  url,
  errorTitle,
}: ExternalReferencePreviewOptions) =>
  queryOptions({
    queryKey: ["external-preview", url, errorTitle],
    queryFn: async ({ signal }) => {
      const response = await api["external-preview"].get({
        query: { url },
        fetch: { signal },
      });
      if (response.error) {
        const error = toAPIError(response.error);
        const toastKey = `${url}|${error.status}`;
        if (
          error.status >= SERVER_PREVIEW_ERROR_THRESHOLD &&
          !toastedPreviewFailures.has(toastKey)
        ) {
          toastedPreviewFailures.add(toastKey);
          notifyUserError(error, errorTitle, { description: error.message });
        }
      }
      return unwrapEden(response);
    },
    retry: false,
    staleTime: 1000 * 60 * 10,
  });
