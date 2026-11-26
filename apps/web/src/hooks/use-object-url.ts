import { useState } from "react";

import { useExternalSyncEffect } from "@stll/ui/effects";

/**
 * A `blob:` URL for an image read through an authenticated client. The URL
 * is revoked when the blob changes or the caller unmounts, and a URL made
 * for an earlier blob is never returned for a newer one.
 */
export const useObjectUrl = (blob: Blob | undefined): string | undefined => {
  const [local, setLocal] = useState<{ blob: Blob; src: string } | null>(null);

  useExternalSyncEffect(() => {
    if (!blob) {
      setLocal(null);
      return undefined;
    }
    const src = URL.createObjectURL(blob);
    setLocal({ blob, src });
    return () => URL.revokeObjectURL(src);
  }, [blob]);

  return local && local.blob === blob ? local.src : undefined;
};
