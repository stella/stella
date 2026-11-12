import { expect, test } from "bun:test";
import path from "node:path";

import { browserEndpointFor } from "./holder-browser";

test("the browser socket sits beside the holder's and is never longer", () => {
  const holder = path.join("/tmp/stella-501", "stella-holder-1.4.0.sock");
  const browser = browserEndpointFor(holder);
  expect(path.dirname(browser)).toBe(path.dirname(holder));
  expect(Buffer.byteLength(browser)).toBeLessThanOrEqual(
    Buffer.byteLength(holder),
  );
  expect(browserEndpointFor(holder)).toBe(browser);
  expect(
    browserEndpointFor(
      path.join("/tmp/stella-501", "stella-holder-1.5.0.sock"),
    ),
  ).not.toBe(browser);
});
