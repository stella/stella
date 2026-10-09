import { SQSClient } from "@aws-sdk/client-sqs";
import { panic } from "better-result";
import * as v from "valibot";

// An in-memory queue behind a real `SQSClient`: the SDK serializes each
// command, signs it and validates response checksums, and this request
// handler answers the AWS JSON protocol for receive, delete and visibility changes.
// Leases are explicit: a received message stays invisible until the test
// calls `expireLeases`, which models its visibility timeout ending.

type FakeSqsMessage = {
  id: string;
  body: string;
  receiveCount: number;
  receiptHandle: string | null;
};

type FakeSqsQueue = {
  readonly client: SQSClient;
  readonly enqueue: (body: string) => string;
  readonly expireLeases: () => void;
  /** Make the next `count` DeleteMessage requests fail with a server error. */
  readonly failDeletes: (count: number) => void;
  /** Make the next `count` visibility release entries fail. */
  readonly failReleases: (count: number) => void;
  readonly deletedMessageIds: readonly string[];
  readonly releasedMessageIds: readonly string[];
  /** Messages still on the queue, leased or not. */
  readonly remaining: () => readonly { id: string; receiveCount: number }[];
  readonly receiveRequests: readonly ReceiveRequest[];
};

const receiveRequestSchema = v.object({
  QueueUrl: v.string(),
  MaxNumberOfMessages: v.number(),
  WaitTimeSeconds: v.optional(v.number()),
  VisibilityTimeout: v.optional(v.number()),
});
type ReceiveRequest = v.InferOutput<typeof receiveRequestSchema>;
const deleteRequestSchema = v.object({
  QueueUrl: v.string(),
  ReceiptHandle: v.string(),
});
const visibilityRequestSchema = v.object({
  QueueUrl: v.string(),
  Entries: v.array(
    v.object({
      Id: v.string(),
      ReceiptHandle: v.string(),
      VisibilityTimeout: v.literal(0),
    }),
  ),
});

type FakeHttpRequest = {
  headers: Record<string, string>;
  body?: unknown;
};
type FakeHttpOptions = { abortSignal?: { aborted: boolean } };

const decodeBody = (body: unknown) => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  return panic("Fake SQS received an unsupported request body");
};

const jsonResponse = (statusCode: number, payload: unknown) => ({
  response: {
    statusCode,
    headers: { "content-type": "application/x-amz-json-1.0" },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  },
});

export const createFakeSqsQueue = (): FakeSqsQueue => {
  const messages: FakeSqsMessage[] = [];
  const receiveRequests: ReceiveRequest[] = [];
  let deleteFailures = 0;
  let releaseFailures = 0;
  let sequence = 0;
  const deletedMessageIds: string[] = [];
  const releasedMessageIds: string[] = [];

  const receive = (body: string) => {
    const request = v.parse(receiveRequestSchema, JSON.parse(body));
    receiveRequests.push(request);
    const leased = messages
      .filter(({ receiptHandle }) => receiptHandle === null)
      .slice(0, request.MaxNumberOfMessages);
    for (const message of leased) {
      message.receiveCount += 1;
      sequence += 1;
      message.receiptHandle = `${message.id}:${sequence}`;
    }
    return jsonResponse(200, {
      Messages: leased.map((message) => ({
        MessageId: message.id,
        ReceiptHandle: message.receiptHandle,
        MD5OfBody: new Bun.CryptoHasher("md5")
          .update(message.body)
          .digest("hex"),
        Body: message.body,
        Attributes: { ApproximateReceiveCount: String(message.receiveCount) },
      })),
    });
  };

  const remove = (body: string) => {
    const request = v.parse(deleteRequestSchema, JSON.parse(body));
    if (deleteFailures > 0) {
      deleteFailures -= 1;
      return jsonResponse(500, {
        __type: "com.amazonaws.sqs#InternalError",
        message: "Injected delete failure",
      });
    }
    // A stale receipt handle deletes nothing, as after a lease expired.
    const index = messages.findIndex(
      ({ receiptHandle }) => receiptHandle === request.ReceiptHandle,
    );
    if (index !== -1) {
      const [deleted] = messages.splice(index, 1);
      if (deleted !== undefined) {
        deletedMessageIds.push(deleted.id);
      }
    }
    return jsonResponse(200, {});
  };

  const release = (body: string) => {
    const request = v.parse(visibilityRequestSchema, JSON.parse(body));
    const failed = [];
    for (const entry of request.Entries) {
      if (releaseFailures > 0) {
        releaseFailures -= 1;
        failed.push({ Id: entry.Id, Code: "InternalError" });
        continue;
      }
      const message = messages.find(
        ({ receiptHandle }) => receiptHandle === entry.ReceiptHandle,
      );
      if (message !== undefined) {
        message.receiptHandle = null;
        releasedMessageIds.push(message.id);
      }
    }
    return jsonResponse(200, { Successful: [], Failed: failed });
  };

  const client = new SQSClient({
    region: "eu-west-1",
    credentials: { accessKeyId: "AKIDFAKESQS", secretAccessKey: "fake-sqs" },
    maxAttempts: 1,
    requestHandler: {
      handle: async (request: FakeHttpRequest, options?: FakeHttpOptions) => {
        if (options?.abortSignal?.aborted) {
          throw new DOMException("The request was aborted", "AbortError");
        }
        const body = decodeBody(request.body);
        const target = request.headers["x-amz-target"];
        if (target === undefined) {
          return panic("Fake SQS received a request without a target");
        }
        switch (target) {
          case "AmazonSQS.ReceiveMessage":
            return await Promise.resolve(receive(body));
          case "AmazonSQS.DeleteMessage":
            return await Promise.resolve(remove(body));
          case "AmazonSQS.ChangeMessageVisibilityBatch":
            return await Promise.resolve(release(body));
          default:
            return panic(`Fake SQS does not implement ${target}`);
        }
      },
    },
  });

  return {
    client,
    enqueue: (body) => {
      sequence += 1;
      const id = `message-${sequence}`;
      messages.push({ id, body, receiveCount: 0, receiptHandle: null });
      return id;
    },
    expireLeases: () => {
      for (const message of messages) {
        message.receiptHandle = null;
      }
    },
    failDeletes: (count) => {
      deleteFailures += count;
    },
    failReleases: (count) => {
      releaseFailures += count;
    },
    deletedMessageIds,
    releasedMessageIds,
    remaining: () =>
      messages.map(({ id, receiveCount }) => ({ id, receiveCount })),
    receiveRequests,
  };
};
