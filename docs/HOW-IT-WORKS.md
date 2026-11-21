# How the tracker works

What Rumble Collection Tracker does in the background, and what it stores where. For using it, see the
[player guide](INSTRUCTIONS.md); for installing it, the [README](../README.md).

## Reading the game

Warcraft Rumble keeps its save in the Windows registry. The tracker only **reads** it; it never changes it.

- While the game runs, the tracker reads the save every 5 seconds.
- When the game closes, it reads it a few more times over the next 30 seconds (the game may still be saving), then
  stops until the game starts again. The status at the top says *Game closed* meanwhile.
- In `RumbleTracker.exe`, the tray icon checks every 2 seconds whether the game runs. From source, a small background
  PowerShell process does the same.

Each read is compared with the previous one: changes (XP, upgrades, currencies, shop, PvP honor and Victory Points)
are added to the history. Nothing is sent anywhere.

## The tray icon

What closing the window does is your choice in **⚙ Settings**: keep running in the tray, so notifications still
arrive, or quit. Until you choose, closing the window asks, and your answer is saved there. Left-click the icon to
bring the window back (an open one comes to the front, as it does when you start the exe again); right-click for *Open
data folder* and *Quit the tracker*. *Quit the tracker*, **⏻ Quit** on the page and Windows signing out or shutting
down all stop it the same way: it finishes a read in progress, writes the day's backup and saves everything first.

## Backups

**Automatic backups** are written to `%APPDATA%\RumbleTracker\backups`:

- when the tracker starts, every 24 hours while it runs, and when it stops;
- one file per day (a later backup on the same day replaces it);
- files older than 7 days are deleted.

They hold everything you entered (names, talents, army slots, armies, reward goals, settings) and the history the
save can't give back (G.R.I.D., PvP and progress). Restore one from **Backup → Automatic backups** on the page.
*Export backup* saves the same content to a file of your choice; *Import backup…* restores such a file.

If a data file is damaged when the tracker starts, it is moved aside (`<name>.corrupt-<date>`) and the tracker starts
without it. Automatic backups pause until the next start, so the damage doesn't replace a good backup: restore the
last good one.

## Game data updates

New events, minis and shop offers after a game patch come as a **data pack** from
[rumble-tracker-data](https://github.com/razingo/rumble-tracker-data), checked at start and every 6 hours. A pack is
installed only if its signature is valid (the key is built into the exe) and every file matches its SHA-256 checksum.
An open window loads the new data by itself.

## App updates

The signed data pack also names the latest release of the tracker and the checksums of its files. When there's a
newer version, a pop-up offers:

- **Download now**: the tracker downloads the release from GitHub, checks the zip and the exe against the checksums in
  the signed pack, replaces `RumbleTracker.exe` and restarts. The previous exe is kept until the new version is
  running; if the new version can't start, the previous one is put back.
- **Later**: hides the pop-up until the tracker restarts.

## Notifications

Notifications are checked every 30 seconds while the tracker runs (in the tray is enough); each is sent once. The
first time the tracker runs, what is already due is only recorded, so you don't get a burst of old notifications.
Choose them in **⚙ Settings**. Clicking one opens the tracker.

## Windows integration (RumbleTracker.exe)

At each start the exe makes sure of these, for your Windows account only:

| What | Why |
|---|---|
| A Start menu shortcut *Rumble Collection Tracker* | Notifications show the tracker's name and icon, and you can start it from the Start menu |
| The `rumble-tracker:` link type (`HKEY_CURRENT_USER\Software\Classes\rumble-tracker`) | Clicking a notification starts the exe, which opens the running tracker's window |
| *Start with Windows*, only if you tick it in **⚙ Settings** (`…\CurrentVersion\Run`, value `RumbleCollectionTracker`) | Starts the tracker in the tray when you sign in |

## Files and folders

| Where | What |
|---|---|
| `%APPDATA%\RumbleTracker` | Your data: what you entered, the history, settings, the installed game data (`gamedata`), automatic backups (`backups`), a downloaded update (`update`, removed once installed) and the log (`tracker.log`, `tracker.previous.log`) |
| `%APPDATA%\RumbleTracker\state` | The last read of each account's save (rebuilt by the next read; not in backups) |
| `%LOCALAPPDATA%\RumbleTracker\app` | The program's files, unpacked from the exe once per version |
| `%LOCALAPPDATA%\RumbleTracker\window\<browser>` | The app window's browser profile (Edge, Chrome, Brave or Vivaldi): the window opens in that browser's app mode with its own profile, separate from your normal browsing, so it keeps its own size and zoom. The files there are the browser's own (cache, settings); the tracker stores nothing of yours in it, and deleting the folder only resets the window |

## Uninstalling

1. In **⚙ Settings**, untick *Start with Windows* if you ticked it.
2. Quit the tracker.
3. Delete `RumbleTracker.exe`, `%APPDATA%\RumbleTracker` and `%LOCALAPPDATA%\RumbleTracker`.
4. Delete the Start menu shortcut *Rumble Collection Tracker* (in the Start menu, right-click it → *Open file
   location*) and, if you like, the registry key `HKEY_CURRENT_USER\Software\Classes\rumble-tracker`.
