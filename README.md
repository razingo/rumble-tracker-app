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

1. Open [Releases](https://github.com/razingo/rumble-tracker-app/releases/latest) and download `RumbleTracker-<version>-win-x64.zip`.
2. Extract the zip anywhere (for example to `Documents\RumbleTracker`) and double-click **RumbleTracker.exe**.
3. The tracker opens in its own window. The first time, it shows the game data download (a minute or less), then the
   tracker.

The tracker reads the game's save every few seconds, so the window updates on its own while you play. What every tab
does is explained in the **[player guide](https://github.com/razingo/rumble-tracker-app/blob/main/docs/INSTRUCTIONS.md)**.

**Its own window:** the tracker uses your browser's app mode: a plain window with no tabs or address bar, with its
own browser profile (your normal browser's bookmarks, extensions and logins aren't touched). That works with Microsoft
Edge (every Windows PC has it), Chrome, Brave and Vivaldi; your default browser is used if it's one of them. Without
any of them (e.g. Firefox only) the tracker opens as a normal browser tab.

**The tray icon:** closing the window doesn't stop the tracker. It keeps running as an icon in the taskbar's
notification area (click **^** if it's hidden), so notifications still arrive. Click the icon to open the window again;
right-click it for *Open data folder* and *Quit tracker*. The **⏻ Quit** button at the top of the tracker also stops
it. Starting the exe again while it's running just brings the window back.

### "Windows protected your PC"

The exe isn't code-signed (that costs money every year), so Windows SmartScreen may warn you the first time. Click
**More info → Run anyway**. You can check that your download is the published one: each release lists the SHA-256
checksums of the zip and the exe; in PowerShell, `Get-FileHash .\RumbleTracker.exe` should show the same value.
Releases are built by GitHub Actions from this repository's source; with the GitHub CLI you can confirm that too:
`gh attestation verify RumbleTracker.exe --repo razingo/rumble-tracker-app`.

## Your data

| What | Where |
|---|---|
| Your own data: names you gave, armies, talents, G.R.I.D. history, progress, notification settings, downloaded game data | `%APPDATA%\RumbleTracker` |
| The tracker's log (`tracker.log`, attach it to a bug report if asked) | `%APPDATA%\RumbleTracker` |
| The program's files, unpacked from the exe on first start, and the window's browser profile | `%LOCALAPPDATA%\RumbleTracker` |

Paste either path into the Explorer address bar to open it. **Back up** with *Backup → Export backup* in the tracker (one JSON file
that *Import backup…* restores, also on another PC).

**Updating:** download the new release and replace `RumbleTracker.exe`. Your data stays where it is.

**Uninstalling:** quit the tracker, then delete `RumbleTracker.exe` and the two `RumbleTracker` folders above.

## Game data updates

After a game patch, new events, minis and shop offers arrive without a new exe: the tracker checks for a new data pack
when it starts and every 6 hours, at <https://razingo.github.io/rumble-tracker-data/>. Packs are signed, and the
tracker only installs a pack with a valid signature from the key built into the exe, so nobody else can push data to
your tracker. If the page says its game data is older than your game, a pack for the new build isn't out yet. If it
says a newer version of the tracker is needed, new packs can only be verified by a newer exe: download the latest
release (your data is kept). When a new version of the tracker is released, a banner (and one notification) says so;
*Not now* hides it until the next version.

## Privacy

- The tracker only **reads** the game's saved data (from the Windows registry). It never changes it, and it ignores
  the login tokens stored next to it.
- It sends nothing about you anywhere. Its only network requests are the data pack downloads (on first start and
  the update checks).
- The local page is only reachable from this PC, and only by the tracker's own page.

## Found a problem?

Click **Report a problem** in the tracker. It shows a short report with technical details (versions and recent
errors, with user names, account IDs and other personal details removed) and opens it as a pre-filled
[issue](https://github.com/razingo/rumble-tracker-app/issues) here, which you can edit before you press Submit. A free GitHub account is needed. You can also
open an issue yourself with the *Bug report* template.

## Options

Start `RumbleTracker.exe` from a Command Prompt or a shortcut to use these:

- **A normal browser tab** instead of the app window: `RumbleTracker.exe --tab`.
- **No window at start** (just the tray icon): `RumbleTracker.exe --no-browser`.
- **Port:** the tracker uses <http://localhost:8765>, or the next free port up to 8784 if another program has it. To
  use one specific port: `set PORT=8800` before starting the exe.
- **Data pack address:** `"dataPackUrl": "https://…/"` in `%APPDATA%\RumbleTracker\config.json` (https only).

## License

The tracker's code is MIT-licensed ([LICENSE](LICENSE)). That license doesn't cover the game art and data, which belong
to Blizzard Entertainment ([NOTICE.md](NOTICE.md)). The exe contains the Node.js runtime and two open-licensed fonts,
whose licenses are in `THIRD-PARTY-NOTICES` in the zip.

## For developers

The tracker is plain Node.js (no npm packages): a local server that reads the game's save and a page it serves on this
PC only. Run it from source with Node.js 20 or newer on Windows:

```
npm run fetch-gamedata
npm start
```

`fetch-gamedata` downloads the game data and art into `gamedata/` (once, and again for newer game data). They aren't
in this repository: they're published, signed, in
[rumble-tracker-data](https://github.com/razingo/rumble-tracker-data), and the download gets the same signature and
checksum checks as players' trackers. Then open http://localhost:8765. Your data goes to `data/` in the project folder (or the folder in
`RUMBLE_DATA_DIR`).

| Folder | What |
|---|---|
| `server/` | the local server (`main.mjs`): scans the save, keeps history, serves the page and its API |
| `server/game/` | reading the save from the registry (`prefs.mjs`), decoding it (`protobuf.mjs`, `model.mjs`), event schedules (`schedule.mjs`) |
| `server/notifications/` | what's due (`notify.mjs`) and Windows notifications (`toast.mjs`) |
| `server/datapack/` | signed game-data updates (`datapack.mjs`) and the public key they must be signed with |
| `web/` | the page: `index.html`, `scripts/` (one file per tab), `styles/` |
| `gamedata/` | the game data and art (© Blizzard, see NOTICE), filled by `npm run fetch-gamedata`, served as `/static/…`; not in the repository |
| `desktop/` | the Windows exe's launcher (app window, tray icon) and its icon |
| `tools/` | `fetch_gamedata.mjs` (`npm run fetch-gamedata`) and `build_release.mjs` (`npm run build-release`, Node.js 25.5+: the single-file exe and the zip; no game data inside, the exe downloads it on first start) |
| `.github/workflows/` | `release.yml`: builds and attests releases on GitHub Actions when a `v<version>` tag is pushed |
| `docs/` | the player guide and its screenshots |

**Security.** The server listens on 127.0.0.1 only and answers only the tracker's own page: requests for another host
name, from another website, or API writes that aren't JSON are refused. The page runs under a strict content security
policy (only its own scripts, no inline script, network requests only to the local server), so keep page code free of
inline event handlers. Game-data updates are only installed with a valid Ed25519 signature and matching SHA-256
checksums.

Bug reports and pull requests are welcome: [issues](https://github.com/razingo/rumble-tracker-app/issues).
