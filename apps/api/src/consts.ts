import { env } from "@/api/env";

// "force" is on too; only `false` turns the mock off.
export const isMockAI = (): boolean => env.USE_MOCK_AI !== false;
