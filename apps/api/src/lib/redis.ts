import { RedisClient } from "bun";

import { env } from "@/api/env";

export const redis = new RedisClient(env.REDIS_URL);
