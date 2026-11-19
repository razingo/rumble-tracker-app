// Currency display names, from the game data: events.json currencyNames (rules.json names for older game data).
// The three event ticket slots (A, B, C) are shared by many events and reset between them, so each is named after the
// event using it now.
import { occurrences } from './schedule.mjs';

/** { name, slot, event }: slot and event only for ticket slots; event is null when no event uses the slot now. */
export function currencyInfo(id, { events, rules, activeEvents = [], now = Date.now() }) {
  const slot = Object.entries(events?.currencies || {}).find(([, v]) => v === id)?.[0];
  if (!slot) {
    const role = Object.entries(rules?.currencyIds || {}).find(([, v]) => v === id)?.[0];
    return { name: events?.currencyNames?.[id] || rules?.currencyDefaultNames?.[role] || null };
  }
  // the schedule first (latest start wins): the save's event list is only as recent as the last game session, so it
  // can still list an event that has ended. The save's list covers events without dates in the game files.
  const users = (events.events || []).filter((ev) => ev.currency === slot);
  const scheduled = users
    .map((ev) => ({ ev, start: ev.schedule ? occurrences(ev, now, now + 1)[0]?.start : undefined }))
    .filter((x) => x.start !== undefined)
    .sort((a, b) => b.start - a.start);
  const live = scheduled[0]?.ev || users.find((ev) => activeEvents.includes(ev.saveId));
  const event = live ? live.name || live.id : null;
  return { name: event ? `${event} tickets` : 'Event tickets', slot, event };
}
