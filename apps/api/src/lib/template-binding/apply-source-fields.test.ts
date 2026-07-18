import { describe, expect, test } from "bun:test";

import type { FieldMeta, FieldSource } from "@/api/handlers/docx/types";

import {
  applySourceFields,
  type BindingContext,
  type ContactSourceRecord,
  EMPTY_BINDING_CONTEXT,
  type FirmSourceRecord,
  type MatterSourceRecord,
  resolveAttorneyField,
  resolveContactField,
  resolveFirmField,
  resolveMatterField,
  type UserSourceRecord,
} from "./apply-source-fields";

const contact = (
  overrides: Partial<ContactSourceRecord> = {},
): ContactSourceRecord => ({
  type: "person",
  displayName: "Jane Doe",
  firstName: "Jane",
  lastName: "Doe",
  organizationName: null,
  emails: null,
  phones: null,
  addresses: null,
  billingAddress: null,
  registrationNumber: null,
  taxId: null,
  bankAccounts: null,
  dataBoxes: null,
  ...overrides,
});

describe("resolveContactField", () => {
  test("returns the person name parts and empty org name", () => {
    const person = contact();
    expect(resolveContactField(person, "displayName")).toBe("Jane Doe");
    expect(resolveContactField(person, "firstName")).toBe("Jane");
    expect(resolveContactField(person, "lastName")).toBe("Doe");
    // organizationName is null on a person, so the field is empty.
    expect(resolveContactField(person, "organizationName")).toBeNull();
  });

  test("returns the org name and empty person parts", () => {
    const org = contact({
      type: "organization",
      displayName: "Acme s.r.o.",
      firstName: null,
      lastName: null,
      organizationName: "Acme s.r.o.",
    });
    expect(resolveContactField(org, "organizationName")).toBe("Acme s.r.o.");
    expect(resolveContactField(org, "firstName")).toBeNull();
  });

  test("blank-but-present values resolve to null, not an empty string", () => {
    expect(
      resolveContactField(contact({ firstName: "  " }), "firstName"),
    ).toBeNull();
  });

  test("an unknown field key resolves to null", () => {
    expect(resolveContactField(contact(), "ssn")).toBeNull();
  });

  test("email/phone use the primary entry, else the first", () => {
    const primary = contact({
      emails: [
        { type: "work", address: "work@example.com", isPrimary: false },
        { type: "personal", address: "primary@example.com", isPrimary: true },
      ],
      phones: [{ type: "mobile", number: "+420 111", isPrimary: false }],
    });
    expect(resolveContactField(primary, "email")).toBe("primary@example.com");
    // No primary phone: falls back to the first entry.
    expect(resolveContactField(primary, "phone")).toBe("+420 111");
  });

  test("empty email/phone lists resolve to null", () => {
    const empty = contact({ emails: [], phones: [] });
    expect(resolveContactField(empty, "email")).toBeNull();
    expect(resolveContactField(empty, "phone")).toBeNull();
  });

  test("address renders the primary entry as a single line, dropping empty parts", () => {
    const withAddress = contact({
      addresses: [
        {
          type: "mailing",
          line1: "Wrong St 9",
          city: "Brno",
          isPrimary: false,
        },
        {
          type: "office",
          line1: "Main St 1",
          line2: "",
          city: "Prague",
          postalCode: "11000",
          country: "Czechia",
          isPrimary: true,
        },
      ],
    });
    expect(resolveContactField(withAddress, "address")).toBe(
      "Main St 1, 11000 Prague, Czechia",
    );
  });

  test("address parts resolve from the primary address", () => {
    const withAddress = contact({
      addresses: [
        {
          type: "office",
          line1: "Main St 1",
          city: "Prague",
          postalCode: "11000",
          country: "Czechia",
          isPrimary: true,
        },
      ],
    });
    expect(resolveContactField(withAddress, "addressStreet")).toBe("Main St 1");
    expect(resolveContactField(withAddress, "addressCity")).toBe("Prague");
    expect(resolveContactField(withAddress, "addressPostalCode")).toBe("11000");
    expect(resolveContactField(withAddress, "addressCountry")).toBe("Czechia");
  });

  test("address and its parts fall back to the billing address", () => {
    const billingOnly = contact({
      addresses: null,
      billingAddress: {
        line1: "Bill St 2",
        city: "Plzeň",
        postalCode: "30100",
      },
    });
    expect(resolveContactField(billingOnly, "address")).toBe(
      "Bill St 2, 30100 Plzeň",
    );
    expect(resolveContactField(billingOnly, "addressStreet")).toBe("Bill St 2");
    expect(resolveContactField(billingOnly, "addressCity")).toBe("Plzeň");
    // The billing address carries no country, so that part is empty.
    expect(resolveContactField(billingOnly, "addressCountry")).toBeNull();
  });

  test("an all-empty address resolves to null", () => {
    expect(
      resolveContactField(
        contact({ billingAddress: { line1: "", city: "" } }),
        "address",
      ),
    ).toBeNull();
  });

  test("registration number and tax id pass through", () => {
    const company = contact({
      registrationNumber: "12345678",
      taxId: "CZ12345678",
    });
    expect(resolveContactField(company, "registrationNumber")).toBe("12345678");
    expect(resolveContactField(company, "taxId")).toBe("CZ12345678");
  });

  test("iban/bic come from the primary-or-first bank account", () => {
    const withBank = contact({
      bankAccounts: [
        { iban: "CZ6508000000192000145399", bic: "GIBACZPX" },
        { iban: "CZ9999999999999999999999", bic: "OTHERXXX" },
      ],
    });
    expect(resolveContactField(withBank, "iban")).toBe(
      "CZ6508000000192000145399",
    );
    expect(resolveContactField(withBank, "bic")).toBe("GIBACZPX");
    // An account with no IBAN resolves the field to null.
    expect(
      resolveContactField(
        contact({ bankAccounts: [{ bic: "GIBACZPX" }] }),
        "iban",
      ),
    ).toBeNull();
  });

  test("dataBox resolves the primary-or-first data box id", () => {
    const withBoxes = contact({
      dataBoxes: [
        { id: "abcd123", isPrimary: false },
        { id: "wxyz789", isPrimary: true },
      ],
    });
    expect(resolveContactField(withBoxes, "dataBox")).toBe("wxyz789");
    expect(
      resolveContactField(contact({ dataBoxes: [] }), "dataBox"),
    ).toBeNull();
  });
});

describe("resolveMatterField", () => {
  const matter: MatterSourceRecord = {
    name: "Smith v. Jones",
    reference: "2026/0042",
    billingReference: "BILL-7",
    status: "active",
  };

  test("returns each matter field, null when empty", () => {
    expect(resolveMatterField(matter, "name")).toBe("Smith v. Jones");
    expect(resolveMatterField(matter, "reference")).toBe("2026/0042");
    expect(resolveMatterField(matter, "billingReference")).toBe("BILL-7");
    expect(resolveMatterField(matter, "status")).toBe("active");
    expect(
      resolveMatterField(
        { ...matter, billingReference: null },
        "billingReference",
      ),
    ).toBeNull();
    expect(resolveMatterField(matter, "unknown")).toBeNull();
  });
});

describe("resolveAttorneyField", () => {
  test("name falls back to the preferred name; email passes through", () => {
    const full: UserSourceRecord = {
      name: "Dr. Eva Novak",
      email: "eva@firm.example",
      preferredName: "Eva",
    };
    expect(resolveAttorneyField(full, "name")).toBe("Dr. Eva Novak");
    expect(resolveAttorneyField(full, "email")).toBe("eva@firm.example");

    const noName: UserSourceRecord = {
      name: null,
      email: "eva@firm.example",
      preferredName: "Eva",
    };
    expect(resolveAttorneyField(noName, "name")).toBe("Eva");
    expect(resolveAttorneyField(noName, "unknown")).toBeNull();
  });
});

describe("resolveFirmField", () => {
  test("returns the firm name, null when empty or unknown", () => {
    const firm: FirmSourceRecord = { name: "Novak & Partners" };
    expect(resolveFirmField(firm, "name")).toBe("Novak & Partners");
    expect(resolveFirmField({ name: null }, "name")).toBeNull();
    expect(resolveFirmField(firm, "registrationNumber")).toBeNull();
  });
});

describe("applySourceFields", () => {
  const sourced = (path: string, source: FieldSource): FieldMeta => ({
    path,
    source,
  });

  const context = (
    overrides: Partial<BindingContext> = {},
  ): BindingContext => ({
    ...EMPTY_BINDING_CONTEXT,
    ...overrides,
  });

  test("dispatches each source kind to the right record", () => {
    const values: Record<string, unknown> = {};
    applySourceFields(
      values,
      {
        fields: [
          sourced("client_name", { kind: "contact", field: "displayName" }),
          sourced("opp_email", {
            kind: "party",
            role: "opposing_party",
            field: "email",
          }),
          sourced("matter_name", { kind: "matter", field: "name" }),
          sourced("attorney_name", {
            kind: "attorney",
            ref: "responsible",
            field: "name",
          }),
          sourced("firm_name", { kind: "firm", field: "name" }),
        ],
      },
      context({
        client: contact({ displayName: "Jane Doe" }),
        parties: {
          opposing_party: contact({
            displayName: "Opp Co",
            emails: [
              { type: "work", address: "opp@example.com", isPrimary: true },
            ],
          }),
        },
        matter: {
          name: "Smith v. Jones",
          reference: null,
          billingReference: null,
          status: "active",
        },
        attorneys: {
          responsible: {
            name: "Eva Novak",
            email: "eva@firm.example",
            preferredName: null,
          },
        },
        firm: { name: "Novak & Partners" },
      }),
    );
    expect(values["client_name"]).toBe("Jane Doe");
    expect(values["opp_email"]).toBe("opp@example.com");
    expect(values["matter_name"]).toBe("Smith v. Jones");
    expect(values["attorney_name"]).toBe("Eva Novak");
    expect(values["firm_name"]).toBe("Novak & Partners");
  });

  test("an explicit value already in the bag is not overwritten", () => {
    const values: Record<string, unknown> = { client_name: "Override Name" };
    applySourceFields(
      values,
      {
        fields: [
          sourced("client_name", { kind: "contact", field: "displayName" }),
        ],
      },
      context({ client: contact() }),
    );
    expect(values["client_name"]).toBe("Override Name");
  });

  test("a field whose record is absent is left unfilled", () => {
    const values: Record<string, unknown> = {};
    applySourceFields(
      values,
      {
        fields: [
          // No client in context.
          sourced("client_name", { kind: "contact", field: "displayName" }),
          // No contact for this role in context.
          sourced("witness_name", {
            kind: "party",
            role: "witness",
            field: "displayName",
          }),
          // No such attorney resolved in context.
          sourced("lead_name", {
            kind: "attorney",
            ref: "lead",
            field: "name",
          }),
        ],
      },
      context(),
    );
    expect(Object.keys(values)).toHaveLength(0);
  });

  test("a field whose value is empty on its record is left unfilled", () => {
    const values: Record<string, unknown> = {};
    applySourceFields(
      values,
      {
        fields: [
          sourced("client_org", { kind: "contact", field: "organizationName" }),
        ],
      },
      context({ client: contact() }),
    );
    expect(Object.hasOwn(values, "client_org")).toBe(false);
  });

  test("no-op without a manifest, and ignores fields with no source", () => {
    const noManifest: Record<string, unknown> = {};
    applySourceFields(noManifest, null, context({ client: contact() }));
    expect(Object.keys(noManifest)).toHaveLength(0);

    const values: Record<string, unknown> = {};
    applySourceFields(
      values,
      { fields: [{ path: "plain_field" }] },
      context({ client: contact() }),
    );
    expect(Object.keys(values)).toHaveLength(0);
  });
});
