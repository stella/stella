import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const API_DIR = fileURLToPath(new URL("../../", import.meta.url));
const NO_PROVIDER_ENV = {
  AI_PROVIDER: "",
  AI_PROVIDER_BASE_URL: "",
  ANTHROPIC_API_KEY: "",
  AZURE_API_KEY: "",
  AZURE_BASE_URL: "",
  AZURE_RESOURCE_NAME: "",
  GOOGLE_AI_API_KEY_CH: "",
  GOOGLE_AI_API_KEY_EU: "",
  GOOGLE_GENERATIVE_AI_API_KEY: "",
  HUGGINGFACE_API_KEY: "",
  HUGGINGFACE_BASE_URL: "",
  MISTRAL_API_KEY: "",
  OPENAI_API_KEY: "",
  OPENROUTER_API_KEY: "",
  REQUIRE_PERSONAL_AI_KEY: "true",
  USE_MOCK_AI: "false",
} as const;

describe("request-path provider resolution without a configured provider", () => {
  test("throws typed 403s without poisoning the shared test module cache", async () => {
    const subprocess = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        "./src/tests/setup-env.ts",
        "./src/lib/ai-models-no-provider.scenario.ts",
      ],
      {
        cwd: API_DIR,
        env: {
          ...process.env,
          ...NO_PROVIDER_ENV,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    expect({ exitCode, stderr, stdout }).toMatchObject({ exitCode: 0 });
  });
});
