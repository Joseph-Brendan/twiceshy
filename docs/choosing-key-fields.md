# Choosing keyFields

This is the most important page in the documentation. A wrong `keyFields` choice is the main way protection fails.

## How Twiceshy decides that two calls are the same call

Twiceshy builds a fingerprint for each call. A fingerprint is a short ID made from four things:

1. The tool name.
2. The server or namespace.
3. The scope, which is who the action belongs to.
4. The selected argument fields, after normalisation.

Two calls with the same fingerprint are the same action. With `keyFields` set, only those fields take part. All other fields are ignored.

The danger is free text. Free text is a field a person can reword, such as `reason`, `note`, `message`, or `description`. An agent often rewrites free text between retries.

## The Kola refund, and why free text lets a duplicate through

Kola's agent sends this refund:

```js
const refund = { transaction: 'T123', amount: 1500, customerId: 'ife', reason: 'missing drink' };
```

The request times out, so the agent retries with a reworded reason:

```js
const rephrased = { transaction: 'T123', amount: 1500, customerId: 'ife', reason: 'the drink was missing from the bag' };
```

Without `keyFields`, the fingerprint includes `reason`. Twiceshy ran these two calls and measured the result:

```text
Refund, no keyFields:
  original reason matches rephrased reason: false
```

The two calls look different, so Ife is refunded twice. That is the bug Twiceshy exists to stop.

Now set `keyFields`:

```js
const refund = guard.wrap('paystack.refund', paystackRefund, {
  keyFields: ['transaction', 'amount'],
});
```

With `transaction` and `amount` selected, `reason` no longer takes part:

```text
Refund, keyFields transaction and amount:
  original reason matches rephrased reason: true
```

The rephrased retry matches, Twiceshy returns the first receipt, and Paystack is called once.

## Worked examples

### 1. A refund

```js
const refund = guard.wrap('paystack.refund', paystackRefund, {
  keyFields: ['transaction', 'amount'],
  normalize: { amount: 'number' },
});
```

Why these fields: a refund is defined by the transaction it reverses and the amount. Two refunds for the same transaction and amount are the same refund, even if the customer or the agent rewrites the reason. A bigger amount is a different action, so `amount` stays in the key. `customerId` is useful for scope, not for identity: the same transaction and amount already identify the refund.

### 2. A bank transfer

```js
const transfer = guard.wrap('bank.transfer', sendTransfer, {
  keyFields: ['accountNumber', 'bankCode', 'amount', 'currency'],
  normalize: { amount: 'number' },
});
```

Why these fields: the money goes to one account at one bank, in one currency, for one amount. The narration is free text, so it is left out. Changing the amount makes a new transfer. Changing only the narration keeps the same transfer. The measured result:

```text
Transfer, keyFields accountNumber, bankCode, amount, currency:
  narration change keeps the same action: true
  amount change makes a new action: true
```

### 3. A sent message

```js
const message = guard.wrap('messages.send', sendMessage, {
  keyFields: ['channel', 'to', 'templateId', 'orderId'],
});
```

Why these fields: a message is defined by the channel, the recipient, the template, and the order it talks about. The body is free text, so it is left out. An agent that rewrites the body does not send a second message. A measured result:

```text
Message, keyFields channel, to, templateId, orderId:
  reworded body keeps the same action: true
```

If you send many different messages to the same person on purpose, add the message ID from your own system to the key. Then each message has its own identity.

### 4. A booking

```js
const booking = guard.wrap('calendar.book', bookSlot, {
  keyFields: ['serviceId', 'startsAt', 'customerId'],
});
```

Why these fields: a booking is defined by the service, the start time, and the customer. Notes are free text and are left out. The same slot for the same customer at the same time is one booking. A different start time is a different booking. A measured result:

```text
Booking, keyFields serviceId, startsAt, customerId:
  notes change keeps the same slot: true
  another start time is a new slot: true
```

`startsAt` is a date string. Normalise dates to one format before they reach Twiceshy so that the same moment always has the same text.

## Normalise values so equal meanings look equal

Paystack, banks, and forms often send numbers as text. Without normalisation, `"1500"` and `1500` are different strings and produce different fingerprints. A measured result:

```text
Amount normalisation:
  plain: "1500" equals 1500: false
  normalize number: "1500" equals 1500: true
```

Use `normalize: { amount: 'number' }` for money fields. Use `trim`, `lowercase`, or `lowercase-trim` for emails and similar text. Twiceshy never changes values unless you ask, because changing a value can change meaning.

## Test your choice in one minute

1. Run the same action twice with the same key fields and a reworded free-text field. Twiceshy should return a duplicate.
2. Run it twice with a different value in one key field, for example a bigger amount. The second call should run as a new action.
3. Run `npx -y @twiceshy/mcp-proxy doctor --config twiceshy.config.json`. When a guarded tool has no `keyFields` and has a free-text field, doctor prints a warning that names the field.

## Rules of thumb

- Include identity fields: transaction IDs, account numbers, recipients, amounts, currencies, dates that define a slot.
- Leave out free text: `note`, `reason`, `message`, `description`, `comment`, `memo`.
- Include any field that changes the meaning of the action. A larger amount is a different action.
- When in doubt, make the key smaller, not bigger. A missing field causes a duplicate. An extra field causes a blocked retry, which is cheaper.
