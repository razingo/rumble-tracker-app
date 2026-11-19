// PvP: reading PvpPlayerRankState and telling wins from losses by Victory Point and honor changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePvp, inferMatches, vpValues } from '../server/game/pvp.mjs';

const varint = (n) => { let v = BigInt(n); const out = []; do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return Buffer.from(out); };
const tag = (fn, wt) => varint((fn << 3) | wt);
const int = (fn, n) => Buffer.concat([tag(fn, 0), varint(n)]);
const msg = (fn, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([tag(fn, 2), varint(body.length), body]); };
const fixed64 = (fn, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return Buffer.concat([tag(fn, 1), b]); };

const RULES = { base: 80, win: 2, loss: 1, streak: [{ upTo: 3, x: 1 }, { upTo: 5, x: 1.25 }] };
const at = (honor, vp, season = 's27') => ({ season, honor, vp });
const match = (from, to) => inferMatches(from, to, RULES);

test('reads season, honor and Victory Points', () => {
  const buf = Buffer.concat([msg(2, fixed64(1, 0x33b4f294d8d12b57n), fixed64(2, 0xccdf8287c654e6c9n)), msg(3, int(1, 9002), int(2, 9002)), msg(4, int(1, 160))]);
  assert.deepEqual(parsePvp(buf), { season: '33b4f294d8d12b57ccdf8287c654e6c9', honor: 9002, honor2: 9002, vp: 160 });
  assert.equal(parsePvp(Buffer.alloc(0)), null);
});

test('Victory Points per match from the rules', () => {
  assert.deepEqual(vpValues(RULES), { loss: 80, wins: [160, 200] });
});

test('one match between scans', () => {
  assert.deepEqual(match(at(5000, 0), at(5090, 160)), { wins: 1, losses: 0, estimated: false, honorOnly: false });
  assert.deepEqual(match(at(5000, 0), at(4940, 80)), { wins: 0, losses: 1, estimated: false, honorOnly: false });
  assert.deepEqual(match(at(5000, 0), at(5100, 200)), { wins: 1, losses: 0, estimated: false, honorOnly: false }); // streak win
});

test('a loss at a rank floor (no honor change) is still a loss', () => {
  assert.deepEqual(match(at(9000, 0), at(9000, 80)), { wins: 0, losses: 1, estimated: false, honorOnly: false });
});

test('honor tells one win from two losses', () => {
  assert.equal(match(at(5000, 0), at(5080, 160)).wins, 1);
  assert.deepEqual(match(at(5000, 0), at(4880, 160)), { wins: 0, losses: 2, estimated: false, honorOnly: false });
  assert.equal(match(at(5000, 0), at(5000, 160)).estimated, true);
});

test('several matches between scans', () => {
  assert.deepEqual(match(at(5000, 0), at(5020, 240)), { wins: 1, losses: 1, estimated: false, honorOnly: false });
});

test('Victory Points unchanged: honor alone, one match', () => {
  assert.deepEqual(match(at(5000, 6000), at(5090, 6000)), { wins: 1, losses: 0, estimated: true, honorOnly: true });
  assert.deepEqual(match(at(5000, 6000), at(4930, 6000)), { wins: 0, losses: 1, estimated: true, honorOnly: true });
  assert.equal(match(at(5000, 6000), at(5000, 6000)), null);
});

test('no matches across seasons, or for impossible changes', () => {
  assert.equal(match(at(9500, 3000, 's26'), at(9000, 0, 's27')), null);
  assert.equal(match(at(5000, 500), at(5000, 400)), null);
  assert.equal(match(at(5000, 0), at(5000, 120)), null);
});
