# Changelog

What changed in each release of Rumble Collection Tracker. The release workflow copies a version's section into its
GitHub release notes.

## 0.9.2

- The player guide explains the *Recent* list in ⚙ Settings and how several notifications of one kind are combined.
- For developers: running from source no longer writes the shop research log (`store_changes.json`); nothing read it.

## 0.9.1

- When several notifications of one kind are due at once, the one notification sent for them says how many there are
  ("12 minis are ready to upgrade") and names the first three, instead of listing all of them. For events and dungeon
  or raid changes, it now names them.
- A file left over from older versions (`.tray-hint-shown`) is removed from the data folder.

## 0.9.0

- The tracker's icon shows in its window and browser tab again.
- The tray menu says *Quit the tracker*, like the close question and ⚙ Settings.
- The player guide now covers what was missing: dragging minis on the Army tab, its lists' filters, a leader's army
  slots, Delete and Clear army, Ctrl+click on reward trees, all notification types, and a PvP screenshot.

## 0.8.4

- If you reopen the window from the tray while the "Close the tracker?" question is open, the tracker keeps running.
  Your answer is still saved for next time.
- Closing several tracker windows at once asks the question only once.
- A notification setting that can't be saved now says so in ⚙ Settings, and goes back to the saved value.
- The Quit button's tooltip says what it does.

## 0.8.3

- The "Close the tracker?" question appears about a second after you close the window, instead of after several.

## 0.8.2

- The first time you close the window, the tracker asks whether to keep running in the tray or quit, and remembers
  your answer. **⚙ Settings → When I close the window** changes it later (exe only).
- Dual-faction leaders are recognized from the game data alone.
- For developers: a release no longer runs the tests a second time; it waits for the Test workflow's run of the same
  commit and is only built when that passed.

## 0.8.1

- Times in sentences are written out ("5 minutes ago", "ends in 3 hours", "every 24 hours"); countdowns keep their
  short form ("4h 12m").
- The G.R.I.D. tab says "Level" instead of "Lvl", like the other tabs.
- For developers: the scripts in `tools/` use kebab-case names (`build-release.mjs` and so on); the npm scripts are
  unchanged.

## 0.8.0

- The Settings note and the guide now say correctly that notifications left unticked under *Also while playing* are
  skipped while the game runs, not held back.
- When the tracker has stopped, the page says so in plain words ("The tracker isn't responding. Is it still running?"),
  and a tab that can't load its data says which data it was.
- The Settings dialog shows an error instead of staying on *Loading…* when the settings can't be read.
- An exported backup is named after your local date, like the automatic ones.
- The trait picker works the same way on the Collection and Army tabs. Searching traits in an Army pool no longer
  changes the Collection's search.
- The G.R.I.D. cooldown note names the special leaders from the game data.
- The Progress tab's heading is now just *Progress*.
- For developers: running from source needs Node.js 22 or newer, and the tests also run on that version on GitHub.

## 0.7.0

- Dates, times and numbers use one format everywhere (US English), whatever the Windows language.
- Clearer messages when something can't be saved, telling you what went wrong and what to do.
- *Send a test notification* no longer says "Sent" when sending failed.
- Simpler wording throughout the page, the guide and the README; the guide has a new Settings screenshot.
- For developers: `npm run check-style` checks line length and whitespace against `.editorconfig`, also on GitHub.

## 0.6.1

- The Backup menu's text wraps inside the menu instead of running past its edge.

## 0.6.0

- **PvP win rate by modifier**: your record while each modifier was active; pick modifiers to filter the win-rate
  chart to the matches played with them.
- New notifications: the PvP season ends soon (claim your Victory Road rewards), and new PvP modifiers (off by
  default). Clicking a notification opens the tracker; notifications show the tracker's own name and icon.
- **Automatic backups** at start, every 24 hours and when the tracker stops, kept for 7 days; restore one from
  *Backup → Automatic backups*.
- Messages and confirmations (Quit, Delete, Restore) appear in the tracker's own style instead of the browser's.
- *Report a problem*: take a screenshot and paste it into the issue.
- After an update the exe's icon is refreshed in Explorer.
- Event ticket slots come from the game data, so a data update can change them.
- For developers: the page is split into ES modules with tests for its calculations; the Calendar and the
  notifications share one schedule module; tests run on GitHub for every push.

## 0.5.0

- **Settings** replaces *Alerts*: notifications as before, plus **Start with Windows** (starts in the tray, no window).
- Updates: the pop-up shows download progress. If a new version fails to start, the previous one is restored.
- A daily backup is written to the data folder's `backups` folder when the tracker stops (Quit, the tray, an update,
  Windows shutting down); the last 7 are kept.
- Uses less memory: the tray icon also checks whether the game is running, instead of a second background process.
- The page refreshes every 5 seconds, and every 60 seconds while its window is minimized.
- New app icon: the kobold on a solid background in a gold frame.
- The shop research log (`store_changes.json`) is no longer written by the exe.

## 0.4.0

- **In-app updates**: when a new version is out, a pop-up offers *Download now* (downloads it from GitHub, checks it
  against the checksums in the signed data pack, installs it and restarts) or *Later*.
- PvP: changes no win/loss combination explains are listed as *unexplained*; mark them as a win or a loss yourself.
- PvP match history is kept in its own file and included in backups.
- The save is only read while Warcraft Rumble is running.
- Quitting from the tray waits for the tracker to finish saving, like Quit on the page.
- Saves can no longer collide; a damaged data file is set aside instead of stopping the tracker.
- The page reloads the game tables after a game-data update.

## 0.3.0

- **PvP tab**: rank and honor, Victory Road, wins and losses worked out from honor and Victory Point changes, the
  modifier rotation and season-end rewards.
- Calendar timeline rows in alphabetical order; the status light is no longer cut off.

## 0.2.1

- Currency names come from the game data; event ticket balances are named after the running event.
- The Ankh shows on the Dungeon card in the Calendar.

## 0.2.0

- The log file has a size cap; the exe carries version details; tests run before every release build.
- Bundled fonts; a notice when a newer version is released; no account names in the log.
- Game data is downloaded on the first start instead of being bundled.

## 0.1.1

- Release builds on GitHub Actions; a notice when a newer version of the tracker is needed for new game data.

## 0.1.0

- First release.
