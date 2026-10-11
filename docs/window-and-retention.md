# Window versus retention

Two time settings control Twiceshy. They sound similar and do different jobs.

- **Window:** how long after an action finishes an identical action counts as a duplicate. Default: 10 minutes.
- **Retention:** how long Twiceshy keeps the record for audit. Default: 7 days.

The window decides what runs. Retention decides what is remembered.

## A timeline example

Ada works at a hair salon and uses a booking agent. Her guard uses the defaults: a 10 minute window and 7 day retention.

| Time | What happens |
|---|---|
| Monday 14:00 | The agent books Ada's customer, Chidi, for Saturday at 3 pm. The booking succeeds. |
| Monday 14:05 | The agent retries the same booking. It is inside the 10 minute window, so Twiceshy returns the first confirmation as a duplicate. There is one booking. |
| Monday 14:11 | The agent retries again. The window has passed, so Twiceshy treats it as a new action and runs it. If the call uses the same explicit key, Twiceshy rejects it with `KEY_CONFLICT` instead, because that key belongs to one booking. |
| Monday 14:12 | The salon owner looks at the history. Both records are still there, for audit. |
| The next Monday | The first record finished more than 7 days ago. Twiceshy's automatic clean up, or a person running `twiceshy purge`, removes it. The history no longer shows that booking. |

The window starts when the action finishes, not when it starts. A slow action does not shorten its own window.

## Why keep records at all

Records are the audit trail. They show what ran, when, who approved a repeat, and what the result was. The arguments are stored after private fields are hidden. When something looks wrong, the record is the first place to look.

## Automatic clean up

Twiceshy removes old records at most once an hour, in the background, and never during a guarded call. `purge` removes records that finished before the retention limit. Records that are in flight or in doubt are never removed. A record in doubt stays until a person resolves it, no matter how old it is.

You can also clean up by hand:

```bash
twiceshy purge --older-than 30d --yes --config twiceshy.config.json
```

Without `--yes`, the command asks for confirmation first.

## Configure both

Library:

```js
const guard = createGuard({
  store,
  window: '10m',
  retention: '7d',
});
```

Proxy config:

```json
{
  "window": "10m",
  "retention": "7d"
}
```

Both accept a number of milliseconds or a string such as `'30s'`, `'10m'`, `'2h'`, or `'7d'`.

## A common mistake

Do not use the window to mean "keep the history for 10 minutes". They are separate settings. If you want a shorter audit trail, change `retention`, not `window`. If you want a longer duplicate-blocking period, change `window`, not `retention`.

A second, related mistake: reusing the same explicit key for a genuinely new action. The explicit key is the identity, so the new action is rejected with `KEY_CONFLICT`. Use a new key for a new action. See [Error reference](errors.md).
