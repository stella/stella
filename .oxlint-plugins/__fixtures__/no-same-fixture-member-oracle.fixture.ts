const fixture = { input: "court text", expected: "court" };
const detectCourt = (value: string) => value;
const detectExpected = detectCourt;
const detectLiteral = detectCourt;
const deriveCourt = (value: string) => value;

expect(detectCourt(fixture.input)).toBe(deriveCourt(fixture.input)); // oxlint-disable-line no-same-fixture-member-oracle/no-same-fixture-member-oracle

const input = fixture.input;
expect(detectCourt(input)).toEqual({ court: fixture.input }); // oxlint-disable-line no-same-fixture-member-oracle/no-same-fixture-member-oracle

// Independent expectations remain valid.
// expect-clean: no-same-fixture-member-oracle/no-same-fixture-member-oracle
expect(detectLiteral(fixture.input)).toBe("court");
expect(detectExpected(fixture.input)).toBe(fixture.expected);
expect({ start: 0, end: fixture.input.length }).toEqual({
  start: 0,
  end: fixture.input.length,
});
