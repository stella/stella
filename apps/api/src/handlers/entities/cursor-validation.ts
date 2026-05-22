const dateCursorPattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const timestampCursorPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}$/u;

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
  const yearPart = match.at(1);
  const monthPart = match.at(2);
  const dayPart = match.at(3);
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

export const isValidTimestampCursorValue = (value: string): boolean => {
  const match = timestampCursorPattern.exec(value);
  if (match === null || parseDateCursorParts(match) === null) {
    return false;
  }

  const hourPart = match.at(4);
  const minutePart = match.at(5);
  const secondPart = match.at(6);
  if (!hourPart || !minutePart || !secondPart) {
    return false;
  }

  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);

  return (
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
};
