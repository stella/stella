import { QueryClient, queryOptions } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import type { ReaderAnnotation } from "@/components/legal-reader/annotations/reader-annotations-query";
import { patchAnnotationCache } from "@/components/legal-reader/annotations/use-optimistic-annotation-mutations";

test("an optimistic mutation leaves an empty cache without a snapshot", async () => {
  const queryClient = new QueryClient();
  const queryKey = queryOptions({
    queryKey: ["reader-annotations", "uncached"],
    queryFn: async (): Promise<ReaderAnnotation[]> => [],
  }).queryKey;

  await patchAnnotationCache(queryClient, queryKey, (rows) => [...rows]);

  expect(queryClient.getQueryData(queryKey)).toBeUndefined();
});
