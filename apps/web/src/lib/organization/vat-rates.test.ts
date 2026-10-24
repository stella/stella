import { afterEach, expect, test } from "bun:test";

import { VAT_RATE_PRESET_COUNTRIES } from "@stll/api-contract";
import { CAPABILITY_REQUEST_HEADER } from "@stll/api-contract/capability-request";

import { createTestState } from "../../../../api/src/tests/helpers/test-state";

const fixture = createTestState({ file: import.meta.path, config: {} });
const originalFetch = globalThis.fetch;
fixture.setEnv(
  "VITE_API_URL",
  process.env["VITE_API_URL"] ?? "https://api.example.test",
);
const { sendVatRateCommand } = await import("./vat-rates");
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.each(VAT_RATE_PRESET_COUNTRIES)(
  "preset command posts the selected %s country and returns its result",
  async (country) => {
    const requests: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ added: 3, skipped: 2 });
      },
      { preconnect: () => undefined },
    );
    expect(await sendVatRateCommand({ type: "applyPreset", country })).toEqual({
      added: 3,
      skipped: 2,
    });
    expect(requests).toHaveLength(1);
    const request = requests.at(0);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get(CAPABILITY_REQUEST_HEADER)).toBe(
      "vat-rates.presets.create",
    );
    expect(
      request === undefined ? undefined : new URL(request.url).pathname,
    ).toBe("/v1/vat-rates/apply-preset");
    expect(await request?.json()).toEqual({ country });
  },
);
