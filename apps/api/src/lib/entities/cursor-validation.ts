const dateCursorPattern = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

type DateCursorParts = {
  year: number;
  month: number;
  day: number;
};

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  if ([1, 3, 5, 7, 8, 10, 12].includes(month)) {
    return 31;
  }

  return 30;
};

const parseDateCursorParts = (
  match: RegExpExecArray,
): DateCursorParts | null => {
  const { year: yearPart, month: monthPart, day: dayPart } = match.groups ?? {};
  if (!yearPart || !monthPart || !dayPart) {
    return null;
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  if (year < 1 || month < 1 || month > 12) {
    return null;
  }

  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  return { day, month, year };
};

export const isValidDateCursorValue = (value: string): boolean => {
  const match = dateCursorPattern.exec(value);
  return match !== null && parseDateCursorParts(match) !== null;
};
