// What closing the app window does: keep the tracker running in the tray, quit it, or ask once and remember the
// answer. The page reports its window closing, and a new page reports itself as the first thing it does. A reload
// therefore shows up well within RELOAD_WAIT, and another open window polls at least every minute; the window only counts
// as closed when neither happens.
import { SECOND } from '../web/scripts/lib/constants.js';

export const CLOSE_CHOICES = ['ask', 'tray', 'quit'];
const RELOAD_WAIT = 600; // ms; a reloaded page reports itself within about 50 ms
const SLOWEST_POLL = 70 * SECOND;

/** `ask()` resolves to 'tray', 'quit' or null (no answer); `quit(reason)` stops the tracker. */
export function createWindowWatch(ctx, { ask, quit, wait = RELOAD_WAIT }) {
  const pages = new Map(); // page ID -> time of its last poll
  let timer = null;

  async function closedForGood() {
    const now = Date.now();
    for (const [id, t] of pages) if (now - t > SLOWEST_POLL) pages.delete(id);
    if (pages.size) return;
    let choice = ctx.user.appSettings.closeWindow;
    if (choice === 'ask') {
      choice = await ask();
      // closing the dialog itself isn't an answer, so it asks again next time
      if (!choice) return;
      ctx.user.appSettings.closeWindow = choice;
      await ctx.user.save('appSettings');
      ctx.bump();
    }
    if (choice === 'quit') quit('Window closed');
  }

  return {
    /** A page opened or polled; `id` is its page ID. */
    seen(id) {
      if (id) pages.set(id, Date.now());
    },
    /** The page `id` reports that its window is closing. */
    closed(id) {
      pages.delete(id);
      clearTimeout(timer);
      timer = setTimeout(() => closedForGood().catch((e) => ctx.errorLog.add('window', e.message)), wait);
    },
  };
}
