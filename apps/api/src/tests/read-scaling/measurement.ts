import { panic } from "better-result";

type ReadScalingMeasurement = {
  statements: number;
  transactionRoundTrips: number;
  responseBytes: number;
  rows: number;
};

type ReadScalingComparison = {
  small: ReadScalingMeasurement;
  large: ReadScalingMeasurement;
};

/** A fixed page pays the same database round trips as its population grows. */
export const readScalingViolations = ({
  small,
  large,
}: ReadScalingComparison) => {
  for (const measurement of [small, large]) {
    if (
      measurement.rows <= 0 ||
      [
        measurement.statements,
        measurement.transactionRoundTrips,
        measurement.responseBytes,
        measurement.rows,
      ].some((value) => !Number.isFinite(value) || value < 0)
    ) {
      panic(
        "Read scaling requires nonempty pages and finite nonnegative measurements",
      );
    }
  }
  const violations: string[] = [];
  if (large.statements !== small.statements) {
    violations.push(`statements: ${small.statements} -> ${large.statements}`);
  }
  if (large.transactionRoundTrips !== small.transactionRoundTrips) {
    violations.push(
      `transaction round trips: ${small.transactionRoundTrips} -> ${large.transactionRoundTrips}`,
    );
  }
  const smallBytesPerRow = small.responseBytes / small.rows;
  const largeBytesPerRow = large.responseBytes / large.rows;
  if (largeBytesPerRow > smallBytesPerRow * 1.2) {
    violations.push(
      `bytes per row: ${smallBytesPerRow} -> ${largeBytesPerRow}`,
    );
  }
  return violations;
};

type WriteScalingMeasurement = {
  statements: number;
  transactionRoundTrips: number;
  responseBytes: number;
};

type WriteScalingComparison = {
  small: WriteScalingMeasurement;
  large: WriteScalingMeasurement;
};

/** A write pays the same database round trips however much its scope holds. */
export const writeScalingViolations = ({
  small,
  large,
}: WriteScalingComparison) => {
  for (const measurement of [small, large]) {
    if (
      measurement.statements <= 0 ||
      [
        measurement.statements,
        measurement.transactionRoundTrips,
        measurement.responseBytes,
      ].some((value) => !Number.isFinite(value) || value < 0)
    ) {
      panic(
        "Write scaling requires executed statements and finite nonnegative measurements",
      );
    }
  }
  const violations: string[] = [];
  if (large.statements !== small.statements) {
    violations.push(`statements: ${small.statements} -> ${large.statements}`);
  }
  if (large.transactionRoundTrips !== small.transactionRoundTrips) {
    violations.push(
      `transaction round trips: ${small.transactionRoundTrips} -> ${large.transactionRoundTrips}`,
    );
  }
  if (large.responseBytes > small.responseBytes * 1.2) {
    violations.push(
      `response bytes: ${small.responseBytes} -> ${large.responseBytes}`,
    );
  }
  return violations;
};
