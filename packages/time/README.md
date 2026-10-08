# @stll/time

Time helpers: named duration constants (`DAY_IN_MS`), calendar-date parsing and
arithmetic (`parsePlainDate`, `parseIsoDateLocal`, `isIsoDateString`,
`addDays`), the user-facing calendar day (`todayFor(zone)`), and a side-effect-free `Temporal` that uses the runtime's native
implementation when it exists.

`DAY_IN_MS` is a duration, not a calendar day: a day that crosses a DST
transition is 23 or 25 hours, so moving to another calendar date goes through
`addDays`.

`todayFor(zone, at?)` is the one way to ask which calendar day it is for a
person: pass the user's or organization's IANA zone. The UTC day
(`Temporal.Now.plainDateISO("UTC")`, `toISOString().slice(0, 10)`) is a
different day for hours around local midnight, and the `calendar-day` lint rule
rejects it as a user-facing day.

`parseTimeZoneId(value)` reads a stored or requested zone into the
`TimeZoneId` brand: the runtime tz database's spelling, or `null` for an
unknown id or a fixed UTC offset (which never observes daylight saving time).
