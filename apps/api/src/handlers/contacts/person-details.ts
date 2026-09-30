import { isCountryCode } from "@stll/country-codes";

import type { DateOfBirth } from "@/api/lib/business-registries/date-of-birth";
import { MAX_CONTACT_NATIONALITY_CODES } from "@/api/lib/business-registries/nationality-codes";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const dateOfBirthFromColumns = ({
  dateOfBirthYear: year,
  dateOfBirthMonth: month,
  dateOfBirthDay: day,
}: {
  dateOfBirthYear: number | null;
  dateOfBirthMonth: number | null;
  dateOfBirthDay: number | null;
}): DateOfBirth | null => {
  if (year === null) {
    return null;
  }
  if (month === null) {
    return { precision: "year", year };
  }
  if (day === null) {
    return { precision: "month", year, month };
  }
  return { precision: "day", year, month, day };
};

export const dateOfBirthToColumns = (dateOfBirth: DateOfBirth | null) => ({
  dateOfBirthYear: dateOfBirth?.year ?? null,
  dateOfBirthMonth:
    dateOfBirth?.precision === "month" || dateOfBirth?.precision === "day"
      ? dateOfBirth.month
      : null,
  dateOfBirthDay: dateOfBirth?.precision === "day" ? dateOfBirth.day : null,
});

export const isValidDateOfBirth = (dateOfBirth: DateOfBirth): boolean => {
  if (
    !Number.isInteger(dateOfBirth.year) ||
    dateOfBirth.year < 1000 ||
    dateOfBirth.year > 9999
  ) {
    return false;
  }
  if (
    dateOfBirth.precision !== "year" &&
    (!Number.isInteger(dateOfBirth.month) ||
      dateOfBirth.month < 1 ||
      dateOfBirth.month > 12)
  ) {
    return false;
  }
  if (dateOfBirth.precision !== "day") {
    return true;
  }
  const { year, month, day } = dateOfBirth;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  let days = 31;
  if (month === 2) {
    days = leap ? 29 : 28;
  } else if ([4, 6, 9, 11].includes(month)) {
    days = 30;
  }
  return Number.isInteger(day) && day >= 1 && day <= days;
};

export const validatePersonDetails = ({
  type,
  dateOfBirth,
  nationalityCodes,
}: {
  type: "person" | "organization";
  dateOfBirth?: DateOfBirth | null | undefined;
  nationalityCodes?: string[] | null | undefined;
}): HandlerError | null => {
  if (
    type === "organization" &&
    ((dateOfBirth !== null && dateOfBirth !== undefined) ||
      (nationalityCodes?.length ?? 0) > 0)
  ) {
    return new HandlerError({
      status: 400,
      message: "Date of birth and nationalities require a person contact",
      issues: [
        ...(dateOfBirth === null || dateOfBirth === undefined
          ? []
          : [{ path: "dateOfBirth", message: "Requires a person contact" }]),
        ...((nationalityCodes?.length ?? 0) > 0
          ? [{ path: "nationalityCodes", message: "Requires a person contact" }]
          : []),
      ],
    });
  }
  if (dateOfBirth && !isValidDateOfBirth(dateOfBirth)) {
    return new HandlerError({
      status: 400,
      message: "Invalid date of birth",
      issues: [{ path: "dateOfBirth", message: "Invalid date of birth" }],
    });
  }
  if (
    nationalityCodes &&
    (nationalityCodes.length > MAX_CONTACT_NATIONALITY_CODES ||
      !nationalityCodes.every(isCountryCode) ||
      new Set(nationalityCodes).size !== nationalityCodes.length)
  ) {
    return new HandlerError({
      status: 400,
      message: "Nationalities must be unique ISO 3166-1 alpha-2 country codes",
      issues: [
        {
          path: "nationalityCodes",
          message:
            "Nationalities must be unique ISO 3166-1 alpha-2 country codes",
        },
      ],
    });
  }
  return null;
};
