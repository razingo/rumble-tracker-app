# Changelog

What changed in each release of Rumble Collection Tracker. The release workflow copies a version's section into its
GitHub release notes.

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
