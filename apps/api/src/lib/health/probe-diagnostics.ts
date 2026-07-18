import { Queue } from "bullmq";

import { env } from "@/api/env";
import { probeDatabase } from "@/api/lib/health/probe-database";
import { createRedisClient, createBullMqConnection } from "@/api/lib/redis-client";
import { getS3 } from "@/api/lib/s3";
import { getSearchProvider } from "@/api/lib/search/provider";
import { probeProvider } from "@/api/lib/ai-provider-probe";
import type { ProviderProbeValue } from "@/api/lib/ai-provider-probe";

export type DiagnosticsResult = {
  db: { status: "ok" | "error"; latencyMs: number };
  redis: { status: "ok" | "error"; backlogJobsCount: number };
  searchProvider: { status: "ok" | "error"; provider: string };
  aiAvailability: {
    configured: boolean;
    providerStatus: { provider: string; status: "reachable" | "unreachable" | "not_tested" }[];
  };
  s3: { status: "ok" | "error"; bucketName: string };
};

export const probeDiagnostics = async (): Promise<DiagnosticsResult> => {
  // 1. DB Probe & Latency
  let dbStatus: "ok" | "error";
  let dbLatency = 0;
  try {
    const start = performance.now();
    await probeDatabase();
    dbLatency = Math.round(performance.now() - start);
    dbStatus = "ok";
  } catch {
    dbStatus = "error";
  }

  // 2. Redis & BullMQ Queue Probe
  let redisStatus: "ok" | "error";
  let backlogJobsCount = 0;
  let redisClient: ReturnType<typeof createRedisClient> | null = null;

  try {
    redisClient = createRedisClient();
    await redisClient.ping();
    redisStatus = "ok";

    const bullConnection = createBullMqConnection();
    const workflowQueue = new Queue("workflows", { connection: bullConnection });
    const fileDerivativesQueue = new Queue("file-derivatives", { connection: bullConnection });

    const [workflowCounts, fileCounts] = await Promise.all([
      workflowQueue.getJobCounts("wait", "active", "delayed", "paused"),
      fileDerivativesQueue.getJobCounts("wait", "active", "delayed", "paused"),
    ]);

    backlogJobsCount =
      (workflowCounts["wait"] ?? 0) +
      (workflowCounts["active"] ?? 0) +
      (workflowCounts["delayed"] ?? 0) +
      (workflowCounts["paused"] ?? 0) +
      (fileCounts["wait"] ?? 0) +
      (fileCounts["active"] ?? 0) +
      (fileCounts["delayed"] ?? 0) +
      (fileCounts["paused"] ?? 0);

    await Promise.all([workflowQueue.close(), fileDerivativesQueue.close()]);
  } catch {
    redisStatus = "error";
  } finally {
    if (redisClient) {
      try {
        redisClient.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  // 3. Search Provider
  let searchStatus: "ok" | "error";
  const searchProviderName = env.LEGAL_SEARCH_PROVIDER ?? "pg-fts";
  try {
    // If pg-fts is configured and DB probe succeeded, search is ok.
    if (searchProviderName === "pg-fts" && dbStatus === "ok") {
      searchStatus = "ok";
    } else {
      // For any other/custom search providers, check their availability via getSearchProvider() or basic ping
      const sp = getSearchProvider();
      if (sp) {
        searchStatus = "ok";
      } else {
        searchStatus = "error";
      }
    }
  } catch {
    searchStatus = "error";
  }

  // 4. S3 Storage
  let s3Status: "ok" | "error";
  const bucketName = env.S3_BUCKET;
  try {
    const s3Client = getS3();
    // Test connectivity via cheap metadata HEAD check
    await s3Client.exists("health-check-probe-temp");
    s3Status = "ok";
  } catch {
    s3Status = "error";
  }

  // 5. AI Availability Probes
  const aiProviders = [
    { name: "google", key: env.GOOGLE_GENERATIVE_AI_API_KEY },
    { name: "anthropic", key: env.ANTHROPIC_API_KEY },
    { name: "openai", key: env.OPENAI_API_KEY },
    { name: "azure_foundry", key: env.AZURE_API_KEY, endpoint: env.AZURE_BASE_URL },
    { name: "openrouter", key: env.OPENROUTER_API_KEY },
    { name: "mistral", key: env.MISTRAL_API_KEY },
    { name: "huggingface", key: env.HUGGINGFACE_API_KEY, endpoint: env.HUGGINGFACE_BASE_URL },
  ];

  const isAnyConfigured = aiProviders.some((p) => !!p.key);

  const probePromises = aiProviders.map(async (provider) => {
    if (provider.key) {
      try {
        const probe = await probeProvider(
          provider.name as ProviderProbeValue,
          provider.key,
          provider.endpoint
        );
        return {
          provider: provider.name,
          status: probe.valid ? ("reachable" as const) : ("unreachable" as const),
        };
      } catch {
        return {
          provider: provider.name,
          status: "unreachable" as const,
        };
      }
    } else {
      return {
        provider: provider.name,
        status: "not_tested" as const,
      };
    }
  });

  const providerStatus = await Promise.all(probePromises);

  return {
    db: { status: dbStatus, latencyMs: dbLatency },
    redis: { status: redisStatus, backlogJobsCount },
    searchProvider: { status: searchStatus, provider: searchProviderName },
    aiAvailability: {
      configured: isAnyConfigured,
      providerStatus,
    },
    s3: { status: s3Status, bucketName },
  };
};
