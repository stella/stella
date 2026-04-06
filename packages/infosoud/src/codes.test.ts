import { describe, expect, test } from "bun:test";

import {
  EVENT_ATTRIBUTE_LABELS,
  EVENT_DESCRIPTIONS,
  EVENT_LABELS,
  EVENT_TOOLTIPS,
  collectUnknownEventAttributeTypes,
  collectUnknownEventTypes,
  collectUnknownInfoSoudCodes,
  getEventDescription,
  getEventAttributeLabel,
  getEventAttributeLabelScopeForOrganizationType,
  getEventLabel,
  getEventLabelScopeForOrganizationType,
  getEventTooltip,
  getEventTypeMetadata,
  isKnownEventAttributeType,
  isKnownEventType,
} from "./codes.js";

describe("InfoSoud code catalog", () => {
  test("exposes the generic event and attribute labels extracted from the public bundle", () => {
    expect(EVENT_LABELS.NAR_JED).toBe("Nařízení jednání");
    expect(EVENT_LABELS.ZAHAJ_RIZ).toBe("Zahájení řízení");
    expect(EVENT_ATTRIBUTE_LABELS.JED_D_ZAC).toBe("Začátek jednání");
    expect(EVENT_ATTRIBUTE_LABELS.ROZH_D_PM).toBe("Datum právní moci");
    expect(EVENT_TOOLTIPS.NAR_JED).toContain("naplánování jednání");
    expect(EVENT_DESCRIPTIONS.ZAHAJ_RIZ).toBe("Bylo zahájeno soudní řízení");
  });

  test("supports scoped label overrides for courts with special wording", () => {
    expect(getEventLabel("ZAHAJ_RIZ")).toBe("Zahájení řízení");
    expect(getEventLabel("ZAHAJ_RIZ", { scope: "ns" })).toBe(
      "Došlo Nejvyššímu soudu",
    );
    expect(getEventDescription("ZAHAJ_RIZ", { scope: "ns" })).toBe(
      "Bylo zahájeno soudní řízení",
    );
    expect(getEventTooltip("ZAHAJ_RIZ", { scope: "ns" })).toContain(
      "Nejvyšším soudu",
    );

    expect(getEventAttributeLabel("OP_D_PODA")).toBe(
      "Datum podání opravného prostředku na poště",
    );
    expect(getEventAttributeLabel("OP_D_PODA", { scope: "ks" })).toBe(
      "Datum doručení OP soudu",
    );
  });

  test("maps organization types to the known scoped label catalogs", () => {
    expect(getEventLabelScopeForOrganizationType("ns")).toBe("ns");
    expect(getEventLabelScopeForOrganizationType("os")).toBeUndefined();
    expect(getEventAttributeLabelScopeForOrganizationType("ks")).toBe("ks");
    expect(getEventAttributeLabelScopeForOrganizationType("ns")).toBe("ns");
    expect(
      getEventAttributeLabelScopeForOrganizationType("vs"),
    ).toBeUndefined();
  });

  test("reports known metadata and unknown code drift explicitly", () => {
    expect(isKnownEventType("NAR_JED")).toBe(true);
    expect(isKnownEventType("NOVA_UDALOST")).toBe(false);
    expect(isKnownEventAttributeType("JED_D_ZAC")).toBe(true);
    expect(isKnownEventAttributeType("X_NEZNAMY")).toBe(false);

    expect(
      getEventTypeMetadata({
        typOrganizace: "ns",
        typUdalosti: "ZAHAJ_RIZ",
      }),
    ).toEqual({
      description: "Bylo zahájeno soudní řízení",
      known: true,
      label: "Došlo Nejvyššímu soudu",
      tooltip: "Bylo zahájeno soudní řízení na Nejvyšším soudu",
    });

    expect(
      collectUnknownEventAttributeTypes({
        atributy: [
          { hodnota: "x", typ: "JED_D_ZAC" },
          { hodnota: "y", typ: "X_NEZNAMY" },
        ],
      }),
    ).toEqual(["X_NEZNAMY"]);
    expect(
      collectUnknownEventTypes([
        { udalost: "NAR_JED" },
        { udalost: "NEZNAMA_UDALOST" },
      ]),
    ).toEqual(["NEZNAMA_UDALOST"]);
    expect(
      collectUnknownInfoSoudCodes({
        details: [
          {
            atributy: [
              { hodnota: "x", typ: "X_NEZNAMY" },
              { hodnota: "y", typ: "JED_SIN" },
            ],
          },
        ],
        events: [{ udalost: "NEZNAMA_UDALOST" }],
      }),
    ).toEqual({
      attributeTypes: ["X_NEZNAMY"],
      eventTypes: ["NEZNAMA_UDALOST"],
    });
  });
});
