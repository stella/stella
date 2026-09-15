import type { QueryClient } from "@tanstack/react-query";

import { collectFileAnonymizationTerms } from "@/lib/anonymize/file-anonymization-policy.logic";
import { anonymizationAllowlistOptions } from "@/lib/workspaces/queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/lib/workspaces/queries/anonymization-terms";

type DetectFileAnonymizationTermsOptions = {
  text: string;
  workspaceId: string;
  entityId: string | null;
  queryClient: QueryClient;
};

export const detectFileAnonymizationTerms = async ({
  text,
  workspaceId,
  entityId,
  queryClient,
}: DetectFileAnonymizationTermsOptions) => {
  const [vocabulary, allowlist, { anonymizeChatTextInWorker }] =
    await Promise.all([
      queryClient.query(anonymizationTermsOptions(workspaceId)),
      queryClient.query(
        anonymizationAllowlistOptions({ workspaceId, entityId }),
      ),
      import("@/lib/anonymize/anonymize-chat-worker-client"),
    ]);
  const excludedCanonicals = allowlist.entries.map(
    ({ canonical }) => canonical,
  );
  const detected = await anonymizeChatTextInWorker({
    text,
    workspaceId,
    excludedCanonicals,
  });
  return collectFileAnonymizationTerms({
    detected: detected.pairs,
    vocabulary: vocabulary.entries,
    excludedCanonicals,
  });
};
