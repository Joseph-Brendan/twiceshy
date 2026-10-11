# Rules for Twiceshy (from SPEC.md Part E)

1. SPEC.md is the source of truth. If code and spec disagree, stop and report it. Do not silently pick one.
2. If anything in the spec is unclear or seems wrong, ask before building. Never invent behaviour for money-moving logic.
3. Read the installed version of every library before using it. Never write SDK code from memory.
4. Write tests before or alongside code, never after. Every required test in C17 must exist with a name that matches its ID, for example `D3: in-flight wait returns first result or IN_PROGRESS`.
5. Never weaken, skip, or delete a test to make it pass. Never add retries to hide a flaky test. Never lower a coverage threshold.
6. Follow every error-handling rule in C9. No empty catch blocks, no `any`, no floating promises, no `console.log` in the proxy package.
7. Never log, store, or print secret values. Redaction tests must stay green.
8. Keep `engine.ts` pure: no database, clock, network, or file access inside it.
9. Finish each phase by running every gate in C18 and showing the real output. Never claim a test passes without running it.
10. Keep changes inside the current phase. Note ideas for later phases in a `NOTES.md` file instead of building them early.
11. Commit after each phase with a clear message naming the phase.
12. Explain decisions in plain English in your phase summary, short enough for a busy reader.
