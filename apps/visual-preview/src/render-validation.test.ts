import { Result } from "better-result";
import { expect, test } from "bun:test";

import { browserEnvironment } from "./env";
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

test("browser environment admits only its runtime dependencies", () => {
  const source = {
    HOME: "/example/home",
    FONTCONFIG_PATH: "/example/fonts",
    LD_LIBRARY_PATH: "/example/lib",
    AWS_ACCESS_KEY_ID: "example-access",
    AWS_SECRET_ACCESS_KEY: "example-secret",
    AWS_SESSION_TOKEN: "example-session",
    AWS_FUTURE_CREDENTIAL: "example-unknown",
    UNRELATED_VALUE: "example-other",
  };
  const env = browserEnvironment(source);
  expect(env).toEqual({
    HOME: source.HOME,
    FONTCONFIG_PATH: source.FONTCONFIG_PATH,
    LD_LIBRARY_PATH: source.LD_LIBRARY_PATH,
  });
  expect(Object.keys(env).some((key) => key.startsWith("AWS_"))).toBe(false);
  expect(browserEnvironment({})).toEqual({});
});
