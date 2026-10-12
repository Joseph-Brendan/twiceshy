# What "in doubt" means and what to do

This page is written for the person who runs the business, not for the developer.

## The story

Kola runs a food delivery app in Lagos. His refund agent sent Ife a 1,500 naira refund through Paystack. The request timed out after 30 seconds. Kola did not know whether the refund went through.

Twiceshy did not guess. It wrote the refund down as **in doubt**. A record in doubt means: this action may or may not have happened. Nobody knows yet.

## Why Twiceshy stops instead of guessing

The two mistakes are not equal:

- If Twiceshy guesses "it happened" and it did not, Ife is paid too little and calls support.
- If Twiceshy guesses "it did not happen" and it did, Ife is paid twice and the money is gone.

The second mistake costs real money. So Twiceshy always stops and asks a person. One blocked action takes you a minute to clear. A double refund can take weeks to recover, and sometimes it is never recovered.

## What your agent sees

When the agent retries, Twiceshy blocks the call with a clear message. The message says:

- What happened: the action is in doubt.
- Why: a previous attempt stopped without confirming whether it completed.
- What to do: a person must check, then resolve the record. It also says: do not retry.

Your agent cannot approve anything by itself. Approval only happens through the commands below, and they ask for your name.

## Step by step

In the commands below, `twiceshy` means the command installed by the proxy package. If you do not have it installed, write `npx -y @twiceshy/mcp-proxy` instead. The `--config` option points at your own config file.

### 1. See what is waiting

```bash
twiceshy list --state IN_DOUBT --config twiceshy.config.json
```

You get a small table: the record ID, the tool, the state, and when it started.

### 2. Read the full record

```bash
twiceshy show bd43ee5c-64bb-4d44-93d2-3d3d97e82248 --config twiceshy.config.json
```

You see the tool, the arguments (private fields are hidden), the money amount, and the times.

### 3. Check the real world

Open the provider's own dashboard, app, or bank statement. For a Paystack refund this is the Paystack dashboard. Search for the transaction ID from the record. Ask yourself one question: did this action really happen?

### 4. Tell Twiceshy what you found

If the action happened:

```bash
twiceshy resolve bd43ee5c-64bb-4d44-93d2-3d3d97e82248 --succeeded --by "kola" --note "checked the Paystack dashboard" --config twiceshy.config.json
```

If the action did not happen:

```bash
twiceshy resolve bd43ee5c-64bb-4d44-93d2-3d3d97e82248 --failed --by "kola" --note "not in the Paystack dashboard" --config twiceshy.config.json
```

`--by` is your name. It is required, because every resolution must name the person who decided.

### 5. A late result can reopen your decision

Sometimes the action finishes after you have already decided. Twiceshy never overwrites what you decided silently:

- If the late result **agrees** with your decision, nothing changes.
- If it **contradicts** your decision, Twiceshy writes a `resolution-conflict` line to its error log and shows the conflict. If you resolved the action as **failed** but it actually **succeeded**, the record goes back to **in doubt** and the next identical call is blocked until a person decides again. This is the safe direction: it is better to ask twice than to pay twice.

### 6. Know what happens next

- **Resolved as succeeded:** the action is treated as done. The next identical attempt inside the window returns the original result as a duplicate. No money moves again.
- **Resolved as failed:** the action is treated as not done. The next identical attempt runs normally.
- **Still not sure:** leave it in doubt. The action stays blocked. Nobody can force it through, and that is the safe outcome.

## The same session, with real output

```text
$ twiceshy list --state IN_DOUBT --config doubt-config.json
ID            TOOL                    STATE              CREATED
bd43ee5c-...  kola-delivery/payst...  IN_DOUBT           2026-10-11 23:17:47

$ twiceshy show bd43ee5c-64bb-4d44-93d2-3d3d97e82248 --config doubt-config.json
id:          bd43ee5c-64bb-4d44-93d2-3d3d97e82248
state:       IN_DOUBT
server:      kola-delivery
tool:        paystack.refund
scope:
fingerprint: fc460b35447d225cba5257467e60ea16da505b3a93907f5035e888811a4eba21
explicitKey: -
attempt:     1
created:     2026-10-11 23:17:47
started:     2026-10-11 23:17:47
completed:   -
error:       -
resolvedBy:  -
resolution:  -
repeatGrant: -
args:        {"transaction":"T123","amount":1500,"customerId":"ife"}

$ twiceshy resolve bd43ee5c-64bb-4d44-93d2-3d3d97e82248 --succeeded --by kola --note "checked the Paystack dashboard" --config doubt-config.json
Record bd43ee5c-64bb-4d44-93d2-3d3d97e82248 resolved as succeeded by kola.

$ twiceshy list --state IN_DOUBT --config doubt-config.json
No records.
```

## When you truly want the action again

Sometimes the customer asks for a second, intentional refund. That is not a duplicate. A person can approve one extra execution:

```bash
twiceshy allow <fingerprint> --by "kola" --note "customer asked for a second refund" --config twiceshy.config.json
```

The record must have succeeded first. A repeat is allowed exactly once, and the record shows who approved it.

## If you are ever unsure

Do not resolve a record just to make the message go away. A record left in doubt blocks the action, which is safe. Ask the developer or the provider to check, then resolve with a note that explains what you found. Your future self will thank you.
