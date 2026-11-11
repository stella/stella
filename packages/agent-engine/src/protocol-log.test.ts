import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  type FieldRule,
  type MessageShape,
  PROTOCOL_ALLOWLISTS,
  PROTOCOL_CHANNELS,
  PROTOCOL_DIRECTIONS,
  protocolTap,
  redactProtocolMessage,
} from "./protocol-log";

/** A generated value and the content strings it holds. */
type Sample = { value: unknown; needles: readonly string[] };

const FINGERPRINT = /#[0-9a-f]{8}/u;

/** Every key, case and vocabulary value the allowlists can print. */
const structuralText = (() => {
  const words: string[] = [
    ...PROTOCOL_CHANNELS,
    ...PROTOCOL_DIRECTIONS,
    "other",
    "unlisted",
    "message",
    "not_json",
  ];
  const walkRule = (rule: FieldRule) => {
    if (rule.type === "vocabulary") {
      words.push(...rule.values);
    }
    if (rule.type === "object" || rule.type === "list") {
      walkShape(rule.shape);
    }
  };
  const walkShape = ({ fields, variant }: MessageShape) => {
    for (const [key, rule] of Object.entries(fields)) {
      words.push(key);
      walkRule(rule);
    }
    if (variant !== null) {
      words.push(variant.key);
      for (const [name, shape] of Object.entries(variant.cases)) {
        words.push(name);
        walkShape(shape);
      }
    }
  };
  for (const channel of PROTOCOL_CHANNELS) {
    for (const direction of PROTOCOL_DIRECTIONS) {
      walkShape(PROTOCOL_ALLOWLISTS[channel][direction]);
    }
  }
  return words.join("\n");
})();

/**
 * A string a member could have written: long enough to recognise, not part
 * of the log's own vocabulary, and not made only of hex digits, which a
 * fingerprint or a number could spell by chance.
 */
const isContent = (text: string) =>
  !structuralText.includes(text) && /[^0-9a-f]/iu.test(text);

// Words too: a leak of only identifier-shaped text must fail as well.
const contentString = fc
  .oneof(
    fc.string({ minLength: 6, maxLength: 24, unit: "binary" }),
    fc.stringMatching(/^[a-z][\w.-]{5,23}$/u),
  )
  .filter(isContent);

/** Content no name, version or instant pattern accepts. */
const spacedContent = contentString.map((text) => `${text} x`);

const needle = (text: string): Sample => ({ value: text, needles: [text] });
const plain = (value: unknown): Sample => ({ value, needles: [] });

const contentSample = contentString.map(needle);

/** JSON holding content anywhere: values, nested values and keys. */
const contentJson: fc.Arbitrary<Sample> = fc.oneof(
  contentSample,
  fc.array(contentSample, { maxLength: 3 }).map((items) => ({
    value: items.map((item) => item.value),
    needles: items.flatMap((item) => item.needles),
  })),
  fc
    .array(fc.tuple(contentString, contentSample), { maxLength: 3 })
    .map((entries) => ({
      value: Object.fromEntries(
        entries.map(([key, item]) => [key, item.value]),
      ),
      needles: entries.flatMap(([key, item]) => [key, ...item.needles]),
    })),
);

const fieldSample = (rule: FieldRule): fc.Arbitrary<Sample> => {
  switch (rule.type) {
    case "vocabulary":
      return fc.oneof(
        fc.constantFrom(...rule.values).map(plain),
        contentSample,
      );
    case "identifier":
      return fc.oneof(contentSample, fc.integer().map(plain));
    case "name":
      return fc.oneof(
        fc
          .constantFrom("Bash", "mcp__stella__search", "gpt-5.1-codex")
          .map(plain),
        spacedContent.map(needle),
      );
    case "version":
      return fc.oneof(
        fc.constant("2.1.309").map(plain),
        spacedContent.map(needle),
      );
    case "instant":
      return fc.oneof(
        fc.constant("2026-11-11T10:00:00.000Z").map(plain),
        spacedContent.map(needle),
      );
    case "number":
      return fc.oneof(fc.double().map(plain), contentSample);
    case "boolean":
      return fc.oneof(fc.boolean().map(plain), contentSample);
    case "size":
      return contentJson;
    case "object":
      return fc.oneof(shapeSample(rule.shape), contentSample);
    case "list":
      return fc.oneof(
        fc.array(shapeSample(rule.shape), { maxLength: 10 }).map((items) => ({
          value: items.map((item) => item.value),
          needles: items.flatMap((item) => item.needles),
        })),
        contentSample,
      );
    default:
      rule satisfies never;
      return panic("A field rule without a sample");
  }
};

/** Keys a shape lists anywhere, which an unlisted key must avoid. */
const listedAnywhere = ({ fields, variant }: MessageShape): string[] => [
  ...Object.keys(fields),
  ...(variant === null
    ? []
    : [
        variant.key,
        ...Object.values(variant.cases).flatMap((shape) =>
          listedAnywhere(shape),
        ),
      ]),
];

type Entry = readonly [string, Sample];

const entriesSample = (shape: MessageShape): fc.Arbitrary<Entry[]> => {
  const listed = new Set(listedAnywhere(shape));
  const fields = fc.tuple(
    ...Object.entries(shape.fields).map(([key, rule]) =>
      fc.option(
        fieldSample(rule).map((sample): Entry => [key, sample]),
        { nil: null },
      ),
    ),
  );
  const { variant } = shape;
  const untagged = fc.constant(null).map((): Entry[] => []);
  const tagged =
    variant === null
      ? untagged
      : fc.oneof(
          untagged,
          contentSample.map((tag): Entry[] => [[variant.key, tag]]),
          fc
            .constantFrom(...Object.keys(variant.cases))
            .chain((name) =>
              entriesSample(
                variant.cases[name] ?? { fields: {}, variant: null },
              ).map((caseEntries): Entry[] => [
                [variant.key, plain(name)],
                ...caseEntries,
              ]),
            ),
        );
  const unlisted = fc.array(
    fc.tuple(
      contentString.filter((key) => !listed.has(key)),
      contentJson,
    ),
    { maxLength: 2 },
  );
  return fc
    .tuple(fields, tagged, unlisted)
    .map(([kept, tag, extra]) => [
      ...kept.flatMap((entry) => (entry === null ? [] : [entry])),
      ...tag,
      ...extra.map(([key, sample]): Entry => [
        key,
        { value: sample.value, needles: [key, ...sample.needles] },
      ]),
    ]);
};

const shapeSample = (shape: MessageShape): fc.Arbitrary<Sample> =>
  entriesSample(shape).map((entries) => ({
    value: Object.fromEntries(
      entries.map(([key, sample]) => [key, sample.value]),
    ),
    needles: entries.flatMap(([, sample]) => sample.needles),
  }));

const messageSample = fc
  .constantFrom(
    ...PROTOCOL_CHANNELS.flatMap((channel) =>
      PROTOCOL_DIRECTIONS.map((direction) => ({ channel, direction })),
    ),
  )
  .chain(({ channel, direction }) =>
    fc
      .oneof(
        {
          weight: 9,
          arbitrary: shapeSample(PROTOCOL_ALLOWLISTS[channel][direction]),
        },
        { weight: 1, arbitrary: contentJson },
      )
      .map((sample) => ({ channel, direction, sample })),
  );

const redact = redactProtocolMessage;

describe("protocol log redaction", () => {
  test("no content string of any message reaches the line", () => {
    assertProperty(
      "protocol log lines carry no content string",
      fc.property(messageSample, ({ channel, direction, sample }) => {
        const line = redact({ channel, direction, message: sample.value });
        expect(line).not.toContain("\n");
        for (const text of sample.needles) {
          expect(line).not.toContain(text);
        }
      }),
      { numRuns: 300 },
    );
  });

  describe("Claude Code", () => {
    const prompt = "Summarise the lease between the landlord and the tenant";
    const command = "cat ./matters/lease-review/lease.docx";

    test("an assistant message keeps block kinds and tool names, not text or input", () => {
      const line = redact({
        channel: "claude-code",
        direction: "in",
        message: {
          type: "assistant",
          session_id: "1c6e2f7a-3b84-4c1e-9d2a-5f0e8b7c6d5e",
          parent_tool_use_id: null,
          message: {
            id: "msg_01ABC",
            model: "claude-sonnet-4-5",
            content: [
              { type: "text", text: prompt },
              {
                type: "tool_use",
                id: "toolu_01",
                name: "Bash",
                input: { command },
              },
            ],
            usage: { input_tokens: 1200, output_tokens: 80 },
          },
        },
      });
      expect(line).toStartWith("type=assistant session_id=#");
      expect(line).toContain("parent_tool_use_id=null");
      expect(line).toContain("message.model=claude-sonnet-4-5");
      expect(line).toContain("message.content=arr:2");
      expect(line).toContain(
        `message.content[0].type=text message.content[0].text=str:${String(prompt.length)}`,
      );
      expect(line).toContain("message.content[1].name=Bash");
      expect(line).toContain("message.content[1].input=obj:1");
      expect(line).toContain("message.usage.input_tokens=1200");
      expect(line).not.toContain(prompt);
      expect(line).not.toContain(command);
      expect(line).not.toContain("msg_01ABC");
    });

    test("a permission prompt and its answer pair up by fingerprint, without the tool input", () => {
      const asked = redact({
        channel: "claude-code",
        direction: "in",
        message: {
          type: "control_request",
          request_id: "req-7",
          request: {
            subtype: "can_use_tool",
            tool_name: "Write",
            tool_use_id: "toolu_02",
            input: {
              file_path: "/srv/matters/lease.md",
              content: prompt,
            },
            decision_reason: "Writes outside the folder",
          },
        },
      });
      const answered = redact({
        channel: "claude-code",
        direction: "out",
        message: {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "req-7",
            response: {
              behavior: "allow",
              updatedInput: {
                file_path: "/srv/matters/lease.md",
                content: prompt,
              },
            },
          },
        },
      });
      expect(asked).toContain(
        "request.subtype=can_use_tool request.tool_name=Write",
      );
      expect(asked).toContain("request.input=obj:2");
      expect(answered).toContain("response.subtype=success");
      expect(answered).toContain("response.response.behavior=allow");
      const requestId = FINGERPRINT.exec(
        asked.split("request_id=")[1] ?? "",
      )?.[0];
      expect(requestId).toBeDefined();
      expect(answered).toContain(`response.request_id=${requestId ?? ""}`);
      for (const line of [asked, answered]) {
        expect(line).not.toContain("lease.md");
        expect(line).not.toContain(prompt);
        expect(line).not.toContain("req-7");
      }
    });

    test("the MCP registration keeps its shape, never the run's secret", () => {
      const line = redact({
        channel: "claude-code",
        direction: "out",
        message: {
          type: "control_request",
          request_id: "stella-2",
          request: {
            subtype: "mcp_set_servers",
            servers: {
              stella: {
                type: "http",
                url: "http://127.0.0.1:41234/mcp/run",
                headers: { Authorization: "Bearer secret-value-123" },
              },
            },
          },
        },
      });
      expect(line).toContain(
        "request.subtype=mcp_set_servers request.servers=obj:1",
      );
      expect(line).not.toContain("secret-value-123");
      expect(line).not.toContain("127.0.0.1");
    });

    test("a result keeps its outcome and counts, and counts fields it does not list", () => {
      const line = redact({
        channel: "claude-code",
        direction: "in",
        message: {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 3,
          total_cost_usd: 0.042,
          result: prompt,
          structured_output: { answer: prompt },
        },
      });
      expect(line).toBe(
        `type=result subtype=success is_error=false num_turns=3 total_cost_usd=0.042 result=str:${String(prompt.length)} unlisted=1`,
      );
    });

    test("system init keeps the model and version, not the folder", () => {
      const line = redact({
        channel: "claude-code",
        direction: "in",
        message: {
          type: "system",
          subtype: "init",
          model: "claude-opus-4-1",
          claude_code_version: "2.1.309",
          cwd: "/srv/matters/lease-review",
          mcp_servers: [{ name: "stella", status: "connected" }],
        },
      });
      expect(line).toContain("type=system subtype=init model=claude-opus-4-1");
      expect(line).toContain("claude_code_version=2.1.309");
      expect(line).toContain(
        "mcp_servers[0].name=stella mcp_servers[0].status=connected",
      );
      expect(line).toContain("cwd=str:");
      expect(line).not.toContain("lease-review");
    });

    test("a type the allowlist does not know shows as other", () => {
      expect(
        redact({
          channel: "claude-code",
          direction: "in",
          message: { type: "brand_new_type", text: prompt },
        }),
      ).toBe("type=other unlisted=1");
    });
  });

  describe("Codex", () => {
    const answer = "The lease ends on 31 December, see clause 4.2.";
    const command = "rg -n termination ./matters/lease-review";

    test("turn/start keeps the input's kinds and sizes, not the prompt", () => {
      const line = redact({
        channel: "codex",
        direction: "out",
        message: {
          id: 7,
          method: "turn/start",
          params: {
            threadId: "thread-a",
            input: [{ type: "text", text: answer, text_elements: [] }],
          },
        },
      });
      expect(line).toMatch(
        /^method=turn\/start id=7 params\.threadId=#[0-9a-f]{8} params\.input=arr:1 params\.input\[0\]\.type=text params\.input\[0\]\.text=str:\d+$/u,
      );
      expect(line).not.toContain(answer);
    });

    test("a finished command keeps its status and exit code, not the command or its output", () => {
      const line = redact({
        channel: "codex",
        direction: "in",
        message: {
          method: "item/completed",
          params: {
            threadId: "thread-a",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "item-3",
              command,
              cwd: "/srv/matters/lease-review",
              status: "completed",
              exitCode: 0,
              aggregatedOutput: answer,
            },
          },
        },
      });
      expect(line).toContain("params.item.type=commandExecution");
      expect(line).toContain("params.item.status=completed");
      expect(line).toContain("params.item.exitCode=0");
      expect(line).toContain(
        `params.item.command=str:${String(command.length)}`,
      );
      expect(line).not.toContain(command);
      expect(line).not.toContain(answer);
      expect(line).not.toContain("lease-review");
    });

    test("an approval request and the decision sent back", () => {
      const asked = redact({
        channel: "codex",
        direction: "in",
        message: {
          id: 0,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-a",
            turnId: "turn-1",
            itemId: "item-3",
            command,
            reason: answer,
          },
        },
      });
      expect(asked).toContain(
        "method=item/commandExecution/requestApproval id=0",
      );
      expect(asked).not.toContain(command);
      expect(asked).not.toContain(answer);
      expect(
        redact({
          channel: "codex",
          direction: "out",
          message: { id: 0, result: { decision: "accept" } },
        }),
      ).toBe("id=0 result.decision=accept");
    });

    test("an error answer keeps its code, not its message", () => {
      expect(
        redact({
          channel: "codex",
          direction: "in",
          message: { id: 4, error: { code: -32_601, message: answer } },
        }),
      ).toBe(
        `id=4 error.code=-32601 error.message=str:${String(answer.length)}`,
      );
    });

    test("thread/start keeps the model, never the MCP token in its config", () => {
      const line = redact({
        channel: "codex",
        direction: "out",
        message: {
          id: 5,
          method: "thread/start",
          params: {
            model: "gpt-5.1-codex",
            cwd: "/srv/matters/lease-review",
            developerInstructions: answer,
            config: {
              "mcp_servers.stella": {
                http_headers: { Authorization: "Bearer secret-value-123" },
              },
            },
          },
        },
      });
      expect(line).toContain("params.model=gpt-5.1-codex");
      expect(line).toContain("params.config=obj:1");
      expect(line).not.toContain("secret-value-123");
      expect(line).not.toContain("lease-review");
      expect(line).not.toContain(answer);
    });

    test("a method the allowlist does not know shows as other", () => {
      expect(
        redact({
          channel: "codex",
          direction: "in",
          message: { method: "item/brandNew/delta", params: { delta: answer } },
        }),
      ).toBe("method=other unlisted=1");
    });
  });

  describe("sidecar", () => {
    const secret = "a".repeat(64);
    const instructions = "Use the stella MCP server for the lease review.";

    test("hello keeps the versions, never the secret", () => {
      expect(
        redact({
          channel: "sidecar",
          direction: "in",
          message: {
            type: "hello",
            protocol: 4,
            secret,
            appVersion: "1.4.0",
            apiOrigin: "https://api.example.test",
            resume: [],
          },
        }),
      ).toBe(
        "type=hello protocol=4 appVersion=1.4.0 apiOrigin=str:24 resume=arr:0 unlisted=1",
      );
    });

    test("run.start keeps the run's settings, not its paths, token or conversation", () => {
      const line = redact({
        channel: "sidecar",
        direction: "in",
        message: {
          type: "run.start",
          runId: "5b1f3c2e-8d4a-4f6b-9e0c-1a2b3c4d5e6f",
          threadId: "thread-1",
          harness: "codex",
          executable: "/opt/stella/codex",
          configDir: "/opt/stella/codex-home",
          launch: {
            configOverrides: [],
            environment: { OPENAI_BASE_URL: "https://proxy.example.test" },
            removedEnvironment: [],
            clientName: null,
            processGrant: true,
          },
          workspaceDir: "/srv/matters/lease-review",
          cacheDir: "/opt/stella/cache",
          model: "gpt-5.1-codex",
          instructions,
          messages: [{ role: "user", content: instructions }],
          attachments: [],
          skillFolders: [],
          toolPath: [],
          harnessSessionId: null,
          policy: { network: "open", fs: "workspace_write", approvals: "ask" },
          mcp: {
            serverName: "stella",
            url: "https://api.example.test/mcp",
            token: "secret-value-123",
            expiresAt: "2026-11-11T12:00:00.000Z",
          },
        },
      });
      expect(line).toContain("type=run.start runId=#");
      expect(line).toContain("harness=codex");
      expect(line).toContain("launch.processGrant=true");
      expect(line).toContain("launch.environment=obj:1");
      expect(line).toContain("model=gpt-5.1-codex");
      expect(line).toContain(
        "mcp.serverName=stella mcp.expiresAt=2026-11-11T12:00:00.000Z",
      );
      expect(line).toContain("messages=arr:1");
      for (const content of [
        "secret-value-123",
        "/opt/stella",
        "/srv/matters",
        "proxy.example.test",
        instructions,
        "5b1f3c2e",
      ]) {
        expect(line).not.toContain(content);
      }
    });

    test("a streamed chunk keeps its event type, not the delta", () => {
      expect(
        redact({
          channel: "sidecar",
          direction: "out",
          message: {
            type: "run.event",
            runId: "5b1f3c2e-8d4a-4f6b-9e0c-1a2b3c4d5e6f",
            seq: 12,
            chunk: {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "m-1",
              delta: instructions,
            },
          },
        }),
      ).toMatch(
        /^type=run\.event runId=#[0-9a-f]{8} seq=12 chunk\.type=TEXT_MESSAGE_CONTENT chunk\.messageId=#[0-9a-f]{8} chunk\.delta=str:\d+$/u,
      );
    });

    test("a rejection names a known message type, never an unknown one", () => {
      expect(
        redact({
          channel: "sidecar",
          direction: "out",
          message: {
            type: "rejected",
            reason: "unknown_type",
            messageType: instructions.slice(0, 40),
            runId: null,
          },
        }),
      ).toBe("type=rejected reason=unknown_type messageType=other runId=null");
    });
  });
});

describe("protocol tap", () => {
  test("redacted writes one line per message, with its size on the wire", () => {
    const lines: string[] = [];
    const tap = protocolTap(
      {
        type: "redacted",
        log: (line) => {
          lines.push(line);
        },
      },
      { channel: "sidecar", source: "connection=1" },
    );
    const message = JSON.stringify({ type: "ack", runId: "r", seq: 3 });
    tap("in", `${message}\n`);
    tap("out", "Přehled {not json");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      new RegExp(
        `^protocol sidecar connection=1 in type=ack runId=#[0-9a-f]{8} seq=3 bytes=${String(message.length)}$`,
        "u",
      ),
    );
    // Bytes, not characters: the size the line had on the wire.
    expect(lines[1]).toBe(
      "protocol sidecar connection=1 out not_json bytes=18",
    );
  });

  test("a log that cannot be written leaves the message flowing", () => {
    const tap = protocolTap(
      {
        type: "redacted",
        log: () => {
          panic("disk full");
        },
      },
      { channel: "codex", source: "pid=7" },
    );
    expect(() => {
      tap("out", JSON.stringify({ method: "initialized" }));
    }).not.toThrow();
  });
});
