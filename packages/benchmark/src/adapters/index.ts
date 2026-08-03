import { createPiiShieldAdapter } from "../blind/pii-shield";
import { createOpenRedactionAdapter } from "./openredaction";
import { createPythonAdapter } from "./python";
import { PYTHON_BENCHMARK_PROVIDERS } from "./python-providers";
import { createRedactPiiAdapter } from "./redact-pii";
import { createStllAdapter } from "./stella";
import type { Adapter } from "./types";

export const createBenchmarkAdapters = (): Adapter[] => [
  createStllAdapter(),
  createOpenRedactionAdapter(),
  ...PYTHON_BENCHMARK_PROVIDERS.map(createPythonAdapter),
  createRedactPiiAdapter(),
  createPiiShieldAdapter(),
];
