import { createGuard, MemoryStore } from 'twiceshy';
import { pass } from './lib.mjs';

let bookings = 0;
async function bookSlot({ salon, day, time }) {
  bookings += 1;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { booked: `${salon} ${day} ${time}`, ref: `bk_${bookings}` };
}

const guard = createGuard({ store: new MemoryStore() });
const book = guard.wrap('salon.book', bookSlot);

const calls = Array.from({ length: 20 }, () =>
  book({ salon: 'Ada Braids Abuja', day: 'Saturday', time: '15:00' }),
);
const results = await Promise.all(calls);

const distinctRefs = new Set(results.map((result) => result.ref)).size;
console.log(`Bookings made: ${bookings}`);
console.log(`Distinct booking refs returned: ${distinctRefs}`);
await guard.close();

pass(
  'Demo 3: twenty parallel calls make one booking',
  bookings === 1 && distinctRefs === 1,
  `bookings ${bookings}, distinct refs ${distinctRefs}`,
);
