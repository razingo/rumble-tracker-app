// Names and units the page, the server and the build tools share. desktop/launcher.cjs keeps its own copies, as it
// runs before the app's files are unpacked.
export const APP_NAME = 'Rumble Collection Tracker';
export const EXE_NAME = 'RumbleTracker.exe';
export const REPO = 'razingo/rumble-tracker-app';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
export const DEFAULT_PORT = 8765;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const MB = 1024 * 1024;
