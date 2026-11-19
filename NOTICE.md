# Notices

## Not affiliated with Blizzard Entertainment

Rumble Collection Tracker is an unofficial fan tool. It is not affiliated with, endorsed, sponsored or approved by
Blizzard Entertainment, Inc. Warcraft, Warcraft Rumble and Blizzard Entertainment are trademarks or registered
trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries.

## What the MIT license covers

The MIT license in `LICENSE` covers the tracker's own code only: the local server (`server/`), the page's scripts
and styles (`web/`), the Windows launcher (`desktop/`) and the build tools (`tools/`).

It does **not** cover the material below, which belongs to its owners and is included only so the tracker can show
your collection in a recognisable way.

## Game art and data © Blizzard Entertainment

Extracted from the game's files and published only in the data repository
(<https://github.com/razingo/rumble-tracker-data>), which the tracker downloads on first start and for updates, and
`npm run fetch-gamedata` into `gamedata/`. None of it is in this repository or in the release downloads:

- images: mini portraits (one of them, the Kobold Miner, is also the app's icon), talent icons, card frames, boards and textures, faction, trait and tag icons, event
  tickets, event reward icons, shop art and currency icons;
- data: mini names, descriptions, traits, talents and stats, event schedules, reward trees and ticket totals, shop
  offers and G.R.I.D. prices, army boards and unit IDs.

© Blizzard Entertainment, Inc. All rights reserved. If Blizzard asks for any of it to be removed, it will be.

## Node.js

`RumbleTracker.exe` is a Node.js single executable application: it contains the Node.js runtime, © Node.js
contributors, MIT-licensed, with third-party components under their own licenses. The full text ships in the zip as
`THIRD-PARTY-NOTICES/Node.js-LICENSE.txt`.

## The player's own data

The tracker reads Warcraft Rumble's saved settings from the Windows registry on the player's own PC, read-only, and
keeps everything it stores in its own data folder on that PC (`%APPDATA%\RumbleTracker`). It sends nothing
anywhere. Its only network requests are the data-pack check, which downloads signed files and sends no player data,
and the page's fonts from Google Fonts. "Report a problem" only opens a pre-filled GitHub issue in the player's
browser; it is sent only if the player submits it there.
