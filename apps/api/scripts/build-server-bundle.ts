/**
 * Builds the API server bundle the way apps/api/Dockerfile builds it, into a
 * directory of the caller's choosing, so the served pull request journeys
 * (scripts/served-mcp-journeys.sh) boot the artifact the release image runs.
 *
 * The command is read from the Dockerfile, never restated: only its output
 * directory and public path are replaced, and every other flag runs as
 * written. NODE_ENV is production, as in the image's build stage, because Bun
 * inlines `process.env.NODE_ENV` reads at bundle time.
 *
 * Usage: bun apps/api/scripts/build-server-bundle.ts <output-directory>
 */
import { panic } from "better-result";
import path from "node:path";

import { childExitStatus } from "../../../packages/scripts/src/child-exit-status";
import { scanBundledConsumers } from "../../../scripts/bundled-consumers";
import { stripSourceMapContent } from "./strip-source-map-content";

const DOCKERFILE = "apps/api/Dockerfile";
const SERVER_ENTRY_NAMING = "--entry-naming server.js";
const IMAGE_FLAGS = { "--outdir": "/app/bundles", "--public-path": "/app/" };

/** The Dockerfile's server build as argv, writing to `outdir` instead. */
export const serverBundleArgv = (
  dockerfile: string,
  outdir: string,
): string[] => {
  const commands = scanBundledConsumers([
    { path: DOCKERFILE, contents: dockerfile },
  ])
    .map(({ command }) => command)
    .filter((command) => command.includes(SERVER_ENTRY_NAMING));
  const [command] = commands;
  if (commands.length !== 1 || command === undefined) {
    return panic(
      `${DOCKERFILE} must hold exactly one server bundle build (${SERVER_ENTRY_NAMING}); found ${String(commands.length)}`,
    );
  }
  // Run as argv, never through a shell: a token a shell would reinterpret
  // means the command is no longer the plain flag list this reads.
  const argv = command.split(" ");
  if (argv.some((token) => /["'`$\\|&;<>(){}*?!~]/u.test(token))) {
    return panic(
      `${DOCKERFILE}'s server bundle build is no longer plain flags; update ${import.meta.file}`,
    );
  }
  for (const [flag, imageValue] of Object.entries(IMAGE_FLAGS)) {
    const positions = argv.flatMap((token, index) =>
      token === flag ? [index] : [],
    );
    const [position] = positions;
    if (
      positions.length !== 1 ||
      position === undefined ||
      argv[position + 1] !== imageValue
    ) {
      return panic(
        `${DOCKERFILE}'s server bundle build must pass ${flag} ${imageValue} exactly once`,
      );
    }
    argv[position + 1] = flag === "--outdir" ? outdir : `${outdir}/`;
  }
  return argv;
};

if (import.meta.main) {
  const [target, ...rest] = process.argv.slice(2);
  if (target === undefined || rest.length > 0) {
    panic(
      "Usage: bun apps/api/scripts/build-server-bundle.ts <output-directory>",
    );
  }
  const root = path.resolve(import.meta.dir, "../../..");
  const outdir = path.resolve(target);
  const argv = serverBundleArgv(
    await Bun.file(path.join(root, DOCKERFILE)).text(),
    outdir,
  );
  const build = Bun.spawn(argv, {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  });
  await build.exited;
  const status = childExitStatus(build);
  if (status !== 0) {
    panic(`Server bundle build exited with ${String(status)}`);
  }
  await stripSourceMapContent(path.join(outdir, "server.js.map"));
}
