# @stll/time

Time helpers: named duration constants (`DAY_IN_MS`), calendar-date parsing and
arithmetic (`parsePlainDate`, `parseIsoDateLocal`, `isIsoDateString`,
`addDays`), and a side-effect-free `Temporal` that uses the runtime's native
implementation when it exists.

`DAY_IN_MS` is a duration, not a calendar day: a day that crosses a DST
transition is 23 or 25 hours, so moving to another calendar date goes through
`addDays`.
