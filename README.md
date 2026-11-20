# Rumble Collection Tracker

An unofficial collection, army and event tracker for **Warcraft Rumble on PC**. It reads your progress from the
game's saved data on your own PC (read-only) and shows it on a local page in your browser: your minis and their
levels, talents and upgrade costs, armies, the G.R.I.D. and what's on cooldown, events and reward trees, shop offers,
your progress over time, and optional Windows notifications.

**Not affiliated with or endorsed by Blizzard Entertainment.** Game art and data © Blizzard Entertainment; see
[NOTICE.md](NOTICE.md).

## Download and run

You need Windows 10 or 11 (64-bit) and Warcraft Rumble for PC, played at least once on this PC. Nothing else: no
Node.js, no installer. The first start needs an internet connection: the tracker downloads its game data (about
4.5 MB) before it opens.

1. Open [Releases](https://github.com/razingo/rumble-tracker-app/releases/latest) and download
   `RumbleTracker-<version>-win-x64.zip`.
2. Extract the zip anywhere (for example to `Documents\RumbleTracker`) and double-click **RumbleTracker.exe**.
3. The tracker opens in its own window. The first time, it shows the game data download (a minute or less), then the
   tracker.

The tracker reads the game's save every few seconds, so the window updates on its own while you play. The
**[player guide](https://github.com/razingo/rumble-tracker-app/blob/main/docs/INSTRUCTIONS.md)** walks through every
tab.

### Its own window

The tracker opens in your browser's app mode, a plain window without tabs or an address bar. It has its own browser
profile, so your bookmarks, extensions and logins aren't touched. This works with Microsoft Edge (every Windows PC has
it), Chrome, Brave and Vivaldi, and your default browser is used if it's one of them. With none of them, for example
Firefox only, the tracker opens as a normal browser tab.

### The tray icon

Closing the window doesn't stop the tracker. It keeps running as an icon in the taskbar's notification area (click
**^** if it's hidden), so notifications still arrive. Click the icon to bring the window back, or right-click it for
*Open data folder* and *Quit tracker*. **⏻ Quit** at the top of the page stops it too, and starting the exe again
while it runs just shows the window. To start it whenever you sign in to Windows, tick *Start with Windows* in
**⚙ Settings**.

### "Windows protected your PC"

The exe isn't code-signed (that costs money every year), so Windows SmartScreen may warn you the first time. Click
**More info → Run anyway**. You can check that your download is the published one: each release lists the SHA-256
checksums of the zip and the exe; in PowerShell, `Get-FileHash .\RumbleTracker.exe` should show the same value.
Releases are built by GitHub Actions from this repository's source; with the GitHub CLI you can confirm that too:
`gh attestation verify RumbleTracker.exe --repo razingo/rumble-tracker-app`.

## Your data

| What | Where |
|---|---|
| Your own data: names you gave, armies, talents, G.R.I.D. and PvP history, progress, notification settings, downloaded game data and app updates | `%APPDATA%\RumbleTracker` |
| Automatic backups (one a day, kept for 7 days) | `%APPDATA%\RumbleTracker\backups` |
| The tracker's log (`tracker.log`, attach it to a bug report if asked) | `%APPDATA%\RumbleTracker` |
| The program's files, unpacked from the exe on first start, and the window's browser profile | `%LOCALAPPDATA%\RumbleTracker` |

Paste either path into the Explorer address bar to open it. *Backup → Export backup* in the tracker saves everything
to one JSON file, which *Import backup…* restores, also on another PC.

### Updating

When a new version is out, the tracker offers to install it. *Download now* fetches the release from GitHub, checks it
against the checksums in the signed data pack, replaces `RumbleTracker.exe` and restarts; if the new version fails to
start, the previous one is put back. You can also download the release yourself and replace the exe. Either way your
data stays where it is. The [changelog](CHANGELOG.md) lists what changed.

### Uninstalling

Untick *Start with Windows* in **⚙ Settings** if you ticked it and quit the tracker. Then delete `RumbleTracker.exe`,
the two `RumbleTracker` folders above and the Start menu shortcut *Rumble Collection Tracker*.
[How the tracker works](docs/HOW-IT-WORKS.md#uninstalling) has the details, along with everything the tracker does in
the background and every place it stores something.

## Game data updates

After a game patch, new events, minis and shop offers arrive without a new exe: the tracker checks for a new data pack
when it starts and every 6 hours, at <https://razingo.github.io/rumble-tracker-data/>. Packs are signed, and the
tracker only installs a pack with a valid signature from the key built into the exe, so nobody else can push data to
your tracker. If the page says its game data is older than your game, a pack for the new build isn't out yet. If it
says a newer version of the tracker is needed, new packs can only be verified by a newer exe: download the latest
release (your data is kept). When a new version of the tracker is released, a pop-up (and one notification) says so;
*Later* hides it until the tracker restarts.

## Privacy

- The tracker only **reads** the game's saved data (from the Windows registry). It never changes it, and it ignores
  the login tokens stored next to it.
- It sends nothing about you anywhere. Its only network requests are the data pack downloads (on first start and
  the update checks).
- The local page is only reachable from this PC, and only by the tracker's own page.

## Found a problem?

Click **Report a problem** in the tracker. It shows a short report with technical details (versions and recent
errors, with user names, account IDs and other personal details removed) and opens it as a pre-filled
[issue](https://github.com/razingo/rumble-tracker-app/issues), which you can edit before you press Submit. This needs a
free GitHub account. You can also open an issue yourself with the *Bug report* template.

## Options

Start `RumbleTracker.exe` from a Command Prompt or a shortcut to use these:

- **A normal browser tab** instead of the app window: `RumbleTracker.exe --tab`.
- **No window at start** (just the tray icon): `RumbleTracker.exe --background` (what *Start with Windows* uses).
- **Port:** the tracker uses <http://localhost:8765>, or the next free port up to 8784 if another program has it. To
  use one specific port: `set PORT=8800` before starting the exe.
- **Data pack address:** `"dataPackUrl": "https://…/"` in `%APPDATA%\RumbleTracker\config.json` (https only).

## License

The tracker's code is MIT-licensed ([LICENSE](LICENSE)). That license doesn't cover the game art and data, which belong
to Blizzard Entertainment ([NOTICE.md](NOTICE.md)). The exe contains the Node.js runtime and two open-licensed fonts,
whose licenses are in `THIRD-PARTY-NOTICES` in the zip.

## For developers

The tracker is plain Node.js (no npm packages): a local server that reads the game's save and a page it serves on this
PC only. Run it from source with Node.js 22 or newer on Windows:

```
npm run fetch-gamedata
npm start
```

`fetch-gamedata` downloads the game data and art into `gamedata/` (once, and again for newer game data). They aren't
in this repository: they're published, signed, in
[rumble-tracker-data](https://github.com/razingo/rumble-tracker-data), and the download gets the same signature and
checksum checks as players' trackers. Then open http://localhost:8765. Your data goes to `data/` in the project
folder, or to the folder in `RUMBLE_DATA_DIR`.

`npm test` runs the tests, which need neither game data nor a save. `npm run check-style` checks the files against
`.editorconfig` (140-character lines, LF, no trailing spaces); CI runs both.

| Folder | What |
|---|---|
| `server/` | The local server. `main.mjs` starts the parts and runs the timers. `host.mjs` connects it to the exe's launcher when there is one. Also the shared state (`context.mjs`), game tables (`tables.mjs`), the user's files (`userdata.mjs`, `store.mjs`), the page's state (`state.mjs`), backups, request filtering (`guard.mjs`), Start with Windows (`autostart.mjs`) and the Windows programs it runs (`system.mjs`) |
| `server/scan/` | Reading the save on a timer (`scanner.mjs`) and the history kept from it (`history.mjs`) |
| `server/http/` | The HTTP server and static files (`server.mjs`), the API routes (`routes.mjs`) and the handlers that change the user's data (`handlers.mjs`) |
| `server/update/` | In-app updates: the download and its checks (`appupdate.mjs`), and *Download now* (`updater.mjs`) |
| `server/game/` | The save: reading it from the registry (`prefs.mjs`), decoding it (`model.mjs`, with `web/scripts/lib/protobuf.js`), currency names, PvP match results and whether the game runs (`watch.mjs`) |
| `server/notifications/` | What's due (`notify.mjs`), sending it (`runner.mjs`) and the Windows notification itself (`toast.mjs`) |
| `server/datapack/` | Signed game-data updates (`datapack.mjs`), when to check (`checker.mjs`), the first start's download (`firstrun.mjs`) and the accepted public keys |
| `web/` | The page. `scripts/app.js` starts it and switches tabs, `core.js` holds what the modules share, and each tab, dialog and menu has its own module; the Army tab also has `army-code.js` (army codes) and `army-pools.js`. `scripts/lib/` has the code the server and build tools use too: shared names and units, formatting, the protobuf reader and writer, schedules, PvP seasons, input limits and the reward-tree planner |
| `gamedata/` | Game data and art (© Blizzard, see NOTICE), served as `/static/…`. Not in the repository; `npm run fetch-gamedata` fills it |
| `desktop/` | The exe's launcher (`launcher.cjs`), the tray icon (`tray.ps1`), Windows integration (`integration.ps1`) and the icon |
| `tools/` | Downloading game data (`fetch-gamedata.mjs`), building the release (`build-release.mjs`, Node.js 25.5+) and the style check (`check-style.mjs`) |
| `test/` | Node's built-in test runner. `helpers.mjs` builds save values and a tracker in a temporary folder; the tray and integration tests run on Windows only |
| `.github/workflows/` | `test.yml` runs the tests and the style check on every push; `release.yml` tests, builds and attests a release when a `v<version>` tag is pushed |
| `docs/` | The player guide with its screenshots, and how the tracker works in the background |

**Security.** The server listens on 127.0.0.1 only and answers only the tracker's own page: requests for another host
name, from another website, or API writes that aren't JSON are refused. The page runs under a strict content security
policy (only its own scripts, no inline script, network requests only to the local server), so keep page code free of
inline event handlers. Game-data updates are only installed with a valid Ed25519 signature and matching SHA-256
checksums.

Bug reports and pull requests are welcome: [issues](https://github.com/razingo/rumble-tracker-app/issues).
