import { API_TEST_TIMEOUT_MS } from "../src/tests/test-timeouts";

type BuildApiTestCommandOptions = {
  bunExecutable: string;
  bunRuntimeArguments: readonly string[];
  testArguments: readonly string[];
  testFiles: readonly string[];
};

export const buildApiTestCommand = ({
  bunExecutable,
  bunRuntimeArguments,
  testArguments,
  testFiles,
}: BuildApiTestCommandOptions) => [
  bunExecutable,
  ...bunRuntimeArguments,
  "test",
  `--timeout=${API_TEST_TIMEOUT_MS}`,
  ...testArguments,
  ...testFiles,
];
