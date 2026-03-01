import { env } from "@/api/env";

export const isMockAI = () => env.USE_MOCK_AI === "true";
