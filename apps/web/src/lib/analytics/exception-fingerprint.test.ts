import { describe, expect, test } from "bun:test";

import { fingerprintExceptionEvent } from "@/lib/analytics/exception-fingerprint";

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

  test("keeps only asset basename and symbol name from each frame", () => {
    expect(
      fingerprintExceptionEvent({
        entries: [
          { type: "TypeError", stacktrace: { frames: matterViewFrames } },
        ],
      }),
    ).toBe(
      "TypeError||root-BOq2mF3k.js:dispatchEvent;matter-view-D3kfQx9a.js:renderMatter|",
    );
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
      "ClientTelemetryError|pdf-viewer|root-BOq2mF3k.js:dispatchEvent;matter-view-D3kfQx9a.js:renderMatter|RangeError",
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
                function: "renderMatter",
              },
            ],
          },
        },
      ],
    });
    expect(fingerprint).toBe(
      "TypeError||matter-view-D3kfQx9a.js:renderMatter|",
    );
    expect(fingerprint).not.toContain("?");
    expect(fingerprint).not.toContain("@");
  });

  test("caps the frame identities at the crash-site end of the stack", () => {
    const deepStack = [
      ...Array.from({ length: 8 }, (_, index) => ({
        filename: "https://my.stll.app/assets/root-BOq2mF3k.js",
        function: `frame${index}`,
      })),
      ...matterViewFrames,
    ];
    expect(
      fingerprintExceptionEvent({
        entries: [{ type: "TypeError", stacktrace: { frames: deepStack } }],
      }),
    ).toBe(
      "TypeError||root-BOq2mF3k.js:frame7;root-BOq2mF3k.js:dispatchEvent;matter-view-D3kfQx9a.js:renderMatter|",
    );
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
