// Passive regression fixture for `no-domain-enum/no-domain-enum`.

// oxlint-disable-next-line no-domain-enum/no-domain-enum
enum LegacyStatus {
  Open = "open",
  Closed = "closed",
}

const STATUS = { open: "open", closed: "closed" } as const;
// expect-clean: no-domain-enum/no-domain-enum
type Status = (typeof STATUS)[keyof typeof STATUS];

export const __domainEnumFixture: Status = STATUS[LegacyStatus.Open];
