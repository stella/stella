// Passive regression fixture for
// `no-raw-cache-control/no-raw-cache-control`.

// oxlint-disable-next-line no-raw-cache-control/no-raw-cache-control -- Cache-Control header name must use its owner
const cacheHeader = "Cache-Control";

// oxlint-disable-next-line no-raw-cache-control/no-raw-cache-control -- raw directive must use its owner
const noStore = "no-store";

// oxlint-disable-next-line no-raw-cache-control/no-raw-cache-control -- raw directive must use its owner
const publicResponse = "public, max-age=300";

// oxlint-disable-next-line no-raw-cache-control/no-raw-cache-control -- interpolated directives must use their owner
const dynamicPolicy = `private, max-age=${300}`;

// expect-clean: no-raw-cache-control/no-raw-cache-control
const unrelated = "public matter metadata";
const domainState = "private";

export const cacheControlFixture = [
  cacheHeader,
  noStore,
  publicResponse,
  dynamicPolicy,
  unrelated,
  domainState,
];
