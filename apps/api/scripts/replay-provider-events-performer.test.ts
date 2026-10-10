import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  ReplayPerformerIdentityError,
  resolveReplayPerformer,
} from "./replay-provider-events-performer";

const TASK_ARN = "arn:aws:ecs:eu-central-1:123456789012:task/cluster/task-id";

test("derives the service performer from ECS task metadata", async () => {
  const identity = await resolveReplayPerformer({
    metadataUri: "http://169.254.170.2/v4/container",
    fetchMetadata: async (url, signal) => {
      expect(url).toBe("http://169.254.170.2/v4/container/task");
      expect(signal.aborted).toBe(false);
      return Response.json({ TaskARN: TASK_ARN });
    },
    localUsername: () => {
      throw new Error("ECS must never fall back to a local user");
    },
  });
  expect(identity.unwrap()).toEqual({
    type: "service",
    id: TASK_ARN,
    name: null,
  });
});

test("refuses ECS identity failures without falling back to a local user", async () => {
  for (const fetchMetadata of [
    async () => {
      throw new Error("metadata unreachable");
    },
    async () => new Response(null, { status: 503 }),
    async () => Response.json({}),
    async () => Response.json({ TaskARN: "claimed-label" }),
    async () => new Response("invalid json"),
  ]) {
    let localLookups = 0;
    const identity = await resolveReplayPerformer({
      metadataUri: "http://169.254.170.2/v4/container",
      fetchMetadata,
      localUsername: () => {
        localLookups++;
        return "operator";
      },
    });
    expect(Result.isError(identity)).toBe(true);
    if (Result.isError(identity)) {
      expect(identity.error).toBeInstanceOf(ReplayPerformerIdentityError);
      expect(identity.error.message).toContain("replay refused");
    }
    expect(localLookups).toBe(0);
  }
});

test("derives the local performer from the OS user without metadata access", async () => {
  const identity = await resolveReplayPerformer({
    metadataUri: undefined,
    localUsername: () => "os-operator",
    fetchMetadata: async () => {
      throw new Error("local runs must not fetch metadata");
    },
  });
  expect(identity.unwrap()).toEqual({ type: "local", username: "os-operator" });
});

test("refuses a missing ECS metadata endpoint instead of claiming a local performer", async () => {
  for (const executionEnvironment of ["AWS_ECS_FARGATE", "AWS_ECS_EC2"]) {
    let localLookups = 0;
    const identity = await resolveReplayPerformer({
      metadataUri: undefined,
      executionEnvironment,
      localUsername: () => {
        localLookups++;
        return "operator";
      },
    });
    expect(Result.isError(identity)).toBe(true);
    if (Result.isError(identity)) {
      expect(identity.error).toBeInstanceOf(ReplayPerformerIdentityError);
    }
    expect(localLookups).toBe(0);
  }
});
