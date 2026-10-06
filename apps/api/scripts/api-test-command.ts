import { mkdirSync } from "node:fs";
import path from "node:path";

import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";

let timingSequence = 0;

type BuildApiTestCommandOptions = {
  bunExecutable: string;
  bunRuntimeArguments: readonly string[];
  testArguments: readonly string[];
  testFiles: readonly string[];
  timingsDirectory?: string;
};

export const buildApiTestCommand = ({
  bunExecutable,
  bunRuntimeArguments,
  testArguments,
  testFiles,
  timingsDirectory = process.env["API_TEST_TIMINGS_DIR"] ??
    path.join(import.meta.dirname, "../.cache/test-timings"),
}: BuildApiTestCommandOptions) => {
  mkdirSync(timingsDirectory, { recursive: true });
  const digest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(testFiles))
    .digest("hex");
  const timingPath = path.join(
    timingsDirectory,
    `${process.pid}-${timingSequence++}-${digest}.json`,
  );
  return [
    bunExecutable,
    ...bunRuntimeArguments,
    "test",
    `--timeout=${API_TEST_TIMEOUT_MS}`,
    `--timings=${timingPath}`,
    "--update-timings",
    ...testArguments,
    ...testFiles,
  ];
};
