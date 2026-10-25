import { describe, expect, test } from "bun:test";
import path from "node:path";

import { BUNDLED_CONSUMERS } from "../../../scripts/bundled-consumers";
import { serverBundleArgv } from "./build-server-bundle";

const dockerfile = await Bun.file(
  path.join(import.meta.dir, "../Dockerfile"),
).text();

describe("server bundle build", () => {
  test("runs the image's registered server build with only its output location replaced", () => {
    const registered = BUNDLED_CONSUMERS.filter(
      ({ file, command }) =>
        file === "apps/api/Dockerfile" &&
        command.includes("--entry-naming server.js"),
    ).map(({ command }) => command);
    expect(registered).toHaveLength(1);
    expect(serverBundleArgv(dockerfile, "/tmp/served-bundle")).toEqual(
      (registered[0] ?? "")
        .replace("--outdir /app/bundles", "--outdir /tmp/served-bundle")
        .replace("--public-path /app/", "--public-path /tmp/served-bundle/")
        .split(" "),
    );
  });

  test("refuses a Dockerfile without exactly one server build", () => {
    const withoutServer = dockerfile.replaceAll(
      "--entry-naming server.js",
      "--entry-naming other.js",
    );
    expect(() => serverBundleArgv(withoutServer, "/tmp/x")).toThrow(
      "exactly one server bundle build",
    );
  });

  test("refuses a server build whose image output location moved", () => {
    const moved = dockerfile.replace(
      "--outdir /app/bundles \\\n    --public-path /app/ \\\n    --entry-naming server.js",
      "--outdir /srv/bundles \\\n    --public-path /app/ \\\n    --entry-naming server.js",
    );
    expect(moved).not.toBe(dockerfile);
    expect(() => serverBundleArgv(moved, "/tmp/x")).toThrow(
      "--outdir /app/bundles exactly once",
    );
  });

  test("refuses a server build a shell would reinterpret", () => {
    const quoted = dockerfile.replace(
      "--entry-naming server.js \\\n    apps/api/src/server.ts",
      '--entry-naming server.js \\\n    "apps/api/src/server.ts"',
    );
    expect(quoted).not.toBe(dockerfile);
    expect(() => serverBundleArgv(quoted, "/tmp/x")).toThrow(
      "no longer plain flags",
    );
  });
});
