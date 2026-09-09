import { describe, expect, test } from "bun:test";

import { fingerprintExceptionEvent as fingerprintExceptionEventWithOrigin } from "@/lib/analytics/exception-fingerprint";

const FIRST_PARTY_ORIGIN = "https://my.stll.app";
const fingerprintExceptionEvent = (
  input: Omit<
    Parameters<typeof fingerprintExceptionEventWithOrigin>[0],
    "firstPartyOrigin"
  >,
) =>
  fingerprintExceptionEventWithOrigin({
    ...input,
    firstPartyOrigin: FIRST_PARTY_ORIGIN,
  });

// Production-shaped frames: bundled asset URLs as posthog-js reports them,
// crash frame last (caller-first ordering).
const matterViewFrames = [
  {
    filename: "https://my.stll.app/assets/root-BOq2mF3k.js",
    function: "dispatchEvent",
    in_app: true,
    lineno: 1,
    colno: 51_204,
  },
  {
    filename: "https://my.stll.app/assets/matter-view-D3kfQx9a.js",
    function: "renderMatter",
    in_app: true,
    lineno: 4,
    colno: 18_733,
  },
] as const;

const documentPanelFrames = [
  {
    filename: "https://my.stll.app/assets/root-BOq2mF3k.js",
    function: "dispatchEvent",
    in_app: true,
    lineno: 1,
    colno: 51_204,
  },
  {
    filename: "https://my.stll.app/assets/document-panel-Ck2pW7dm.js",
    function: "openDocument",
    in_app: true,
    lineno: 2,
    colno: 9812,
  },
] as const;

describe("fingerprintExceptionEvent", () => {
  test("distinct defects in distinct components produce distinct fingerprints", () => {
    const matterView = fingerprintExceptionEvent({
      entries: [
        { type: "TypeError", stacktrace: { frames: matterViewFrames } },
      ],
    });
    const documentPanel = fingerprintExceptionEvent({
      entries: [
        { type: "TypeError", stacktrace: { frames: documentPanelFrames } },
      ],
    });
    expect(matterView).not.toBe(documentPanel);
  });

  test("the same error fingerprints identically on every occurrence", () => {
    const entry = {
      type: "RangeError",
      stacktrace: { frames: matterViewFrames },
    };
    expect(
      fingerprintExceptionEvent({ area: "pdf-viewer", entries: [entry] }),
    ).toBe(fingerprintExceptionEvent({ area: "pdf-viewer", entries: [entry] }));
  });

  test("keeps only the asset basename from each frame", () => {
    expect(
      fingerprintExceptionEvent({
        entries: [
          { type: "TypeError", stacktrace: { frames: matterViewFrames } },
        ],
      }),
    ).toBe("TypeError||root.js;matter-view.js|");
  });

  test("the area slug and cause-chain classes separate otherwise identical errors", () => {
    const wrapper = {
      type: "ClientTelemetryError",
      stacktrace: { frames: matterViewFrames },
    };
    const entries = [wrapper, { type: "RangeError" }];
    const fingerprint = fingerprintExceptionEvent({
      area: "pdf-viewer",
      entries,
    });
    expect(fingerprint).toBe(
      "ClientTelemetryError|pdf-viewer|root.js;matter-view.js|RangeError",
    );
    expect(fingerprint).not.toBe(fingerprintExceptionEvent({ entries }));
    expect(fingerprint).not.toBe(
      fingerprintExceptionEvent({
        area: "pdf-viewer",
        entries: [wrapper, { type: "AbortError" }],
      }),
    );
  });

  test("strips query strings and fragments before taking the basename", () => {
    const fingerprint = fingerprintExceptionEvent({
      entries: [
        {
          type: "TypeError",
          stacktrace: {
            frames: [
              {
                filename:
                  "https://my.stll.app/assets/matter-view-D3kfQx9a.js?token=phx_9f3b2c&email=jana.novakova@example.com#L4",
                in_app: true,
              },
            ],
          },
        },
      ],
    });
    expect(fingerprint).toBe("TypeError||matter-view.js|");
    expect(fingerprint).not.toContain("?");
    expect(fingerprint).not.toContain("@");
  });

  test("caps the frame identities at the crash-site end of the stack", () => {
    const deepStack = [
      ...Array.from({ length: 8 }, (_, index) => ({
        filename: "https://my.stll.app/assets/root-BOq2mF3k.js",
        function: `frame${index}`,
        in_app: true,
      })),
      ...matterViewFrames,
    ];
    expect(
      fingerprintExceptionEvent({
        entries: [{ type: "TypeError", stacktrace: { frames: deepStack } }],
      }),
    ).toBe("TypeError||root.js;root.js;matter-view.js|");
  });

  test("frameless and entryless events still yield a stable class-level identity", () => {
    expect(fingerprintExceptionEvent({ entries: [] })).toBe("UnknownError|||");
    expect(
      fingerprintExceptionEvent({
        entries: [{ type: "UnhandledRejection" }],
      }),
    ).toBe("UnhandledRejection|||");
  });
});

test("fingerprint is stable across content-hashed chunk renames", () => {
  const input = (filename: string) => ({
    entries: [
      {
        type: "TypeError",
        stacktrace: {
          frames: [{ filename, function: "renderMatter", in_app: true }],
        },
      },
    ],
  });
  const a = fingerprintExceptionEvent(
    input("https://my.stll.app/assets/matter-view-D3kfQx9a.js"),
  );
  const b = fingerprintExceptionEvent(
    input("https://my.stll.app/assets/matter-view-Bx91kQwe.js"),
  );
  // Different content hashes must not split the issue; the fixture differs
  // before the equivalence is asserted.
  expect("matter-view-D3kfQx9a.js").not.toBe("matter-view-Bx91kQwe.js");
  expect(a).toBe(b);
  const c = fingerprintExceptionEvent(
    input("https://my.stll.app/assets/other-view-D3kfQx9a.js"),
  );
  expect(a).not.toBe(c);
});

test("an API error carries its response identity as a trailing component", () => {
  const entries = [
    {
      type: "ApiError",
      stacktrace: { frames: [matterViewFrames[1]] },
    },
  ];
  const withoutHttp = fingerprintExceptionEvent({ entries });
  expect(withoutHttp).toBe("ApiError||matter-view.js|");
  expect(fingerprintExceptionEvent({ entries, http: { status: 404 } })).toBe(
    `${withoutHttp}|404`,
  );
  expect(
    fingerprintExceptionEvent({
      entries,
      http: { status: 402, code: "usage_limit_exceeded" },
    }),
  ).toBe(`${withoutHttp}|402:usage_limit_exceeded`);
  // Outcomes group separately; the same outcome groups together.
  expect(
    fingerprintExceptionEvent({ entries, http: { status: 503 } }),
  ).not.toBe(fingerprintExceptionEvent({ entries, http: { status: 404 } }));
});

test("hash-shaped suffixes outside first-party assets remain identity", () => {
  const fingerprint = (filename: string) =>
    fingerprintExceptionEvent({
      entries: [
        {
          type: "TypeError",
          stacktrace: {
            frames: [
              {
                filename,
                // PostHog's parser reports ordinary external URLs as true,
                // so this flag cannot grant the first-party build contract.
                in_app: true,
              },
            ],
          },
        },
      ],
    });

  expect(fingerprint("https://cdn.example/document-12345678.js")).toBe(
    "TypeError||document-12345678.js|",
  );
  expect(fingerprint("https://my.stll.app/vendor/document-12345678.js")).toBe(
    "TypeError||document-12345678.js|",
  );
});

test("data-derived symbols and deployed positions never enter identity", () => {
  const fingerprint = ({
    colno,
    lineno,
    symbol,
  }: {
    colno: number;
    lineno: number;
    symbol: string;
  }) => {
    const frame = {
      filename: "https://my.stll.app/assets/matter-view-A1b2C3d4.js",
      function: symbol,
      in_app: true,
      lineno,
      colno,
    };
    return fingerprintExceptionEvent({
      entries: [
        {
          type: "TypeError",
          stacktrace: { frames: [frame] },
        },
      ],
    });
  };

  const dataDerived = fingerprint({
    colno: 7,
    lineno: 1,
    symbol: "jana_novakova",
  });
  const renamedAndShifted = fingerprint({
    colno: 18_733,
    lineno: 42,
    symbol: "renderMatter2",
  });
  expect(dataDerived).toBe(renamedAndShifted);
  expect(dataDerived).toBe("TypeError||matter-view.js|");
});
