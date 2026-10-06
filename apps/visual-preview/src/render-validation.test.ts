import { Result } from "better-result";
import { expect, test } from "bun:test";

import { renderVisual, type VisualPreviewLaunchOptions } from "./render";

test("rejects UTF-8 documents beyond the shared bound before launching", async () => {
  const result = await renderVisual({
    input: { document: "€".repeat(800_000), viewport: { width: 1200 } },
    launch: async () => {
      throw new Error("Browser must not launch");
    },
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toBe("Invalid preview input");
  }
});

test("supplies the renderer launch policy before opening a browser", async () => {
  const launches: VisualPreviewLaunchOptions[] = [];
  const result = await renderVisual({
    input: { document: "", viewport: { width: 1200 } },
    launch: async (options) => {
      launches.push(options);
      throw new Error("Example browser unavailable");
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(launches).toHaveLength(1);
  const options = launches.at(0);
  expect(options?.args).toContain(
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  );
  expect(options?.args).toContain(
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  );
});
