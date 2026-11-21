// Passive regression fixture for
// `require-polite-publisher-fetch/require-polite-publisher-fetch`.

import type { createPolitePublisherFetch } from "@stll/fetch/publisher";

declare const politePublisherFetch: ReturnType<
  typeof createPolitePublisherFetch
>;
declare const options: Parameters<typeof politePublisherFetch>[1];
declare const url: string;

// oxlint-disable-next-line require-polite-publisher-fetch/require-polite-publisher-fetch
export const rawPublisherResponse = await fetch(url);

// expect-clean: require-polite-publisher-fetch/require-polite-publisher-fetch
export const governedPublisherResponse = await politePublisherFetch(
  url,
  options,
);
