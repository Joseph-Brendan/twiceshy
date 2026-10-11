# Notes

## The decision engine in plain English

When a guarded call arrives, Twiceshy finds the record for that action, by explicit key or fingerprint, and asks: has this already happened?

- No record: run it, and claim the record as "in flight" with a lease, a timed claim the running process keeps renewing.
- Succeeded inside the window: do not run it again; return the original result marked as a duplicate.
- Succeeded before the window started: run it as a fresh action.
- Still running: wait briefly for the first call, then follow its new state or report IN_PROGRESS.
- Running but the lease expired: the process likely died. Mark it "in doubt" and refuse; a person decides.
- Failed definitely: safe to run again, counting the attempt.
- In doubt: refuse until a person resolves it.
- A person can grant one repeat, which allows exactly one extra execution.

If a result arrives after a timeout, Twiceshy upgrades "in doubt" to succeeded or failed when it can, so no human is needed.
