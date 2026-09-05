# Not doing: a staged two-version cutover

The migration and the code that reads it ship together rather than behind a
version flag. Promote runs the migration task to completion and only then rolls
the service, so the two shapes overlap for the rolling swap window, a few
minutes. Within that window the only hazard is a write in one of the 26
currencies whose exponent is not two, from a task still on the old build: a
task-hours or expense amount stored under the hundredths rule after the rescale
has passed over its table. Every other currency is unaffected, because the
migration does not touch it. No workspace in this repository is known to hold
rows in those currencies, and a versioned dual-read model — a column recording
which rule each row was written under, plus a reader that branches on it —
would outlive the window it exists for and have to be removed in a later
release anyway. A single cutover with a bounded, enumerable exposure is the
smaller change.
