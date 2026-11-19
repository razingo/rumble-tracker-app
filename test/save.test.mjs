// Save decoding: protobuf reader and the record parsers, on hand-built messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVarint, parseMessage } from '../server/game/protobuf.mjs';
import { parseUnits, parseCurrencies, parseGameBuild, parseOwnedAvatars, compareBuilds } from '../server/game/model.mjs';

// minimal protobuf writer
const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const tag = (fn, wt) => varint((fn << 3) | wt);
const int = (fn, n) => Buffer.concat([tag(fn, 0), varint(n)]);
const msg = (fn, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([tag(fn, 2), varint(body.length), body]); };
const str = (fn, s) => msg(fn, Buffer.from(s, 'utf8'));
const fixed64 = (fn, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return Buffer.concat([tag(fn, 1), b]); };
const double = (fn, n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return Buffer.concat([tag(fn, 1), b]); };
const id = (fn, a, b) => msg(fn, fixed64(1, a), fixed64(2, b));
const hexId = (a, b) => a.toString(16).padStart(16, '0') + b.toString(16).padStart(16, '0');

test('varints', () => {
  assert.deepEqual(readVarint(Buffer.from([0x96, 0x01]), 0), [150n, 2]);
  assert.deepEqual(readVarint(varint(2n ** 40n), 0), [2n ** 40n, 6]);
  assert.throws(() => readVarint(Buffer.from([0x80]), 0), /past end/);
});

test('messages: wire types and malformed input', () => {
  const buf = Buffer.concat([int(1, 7), str(2, 'hi'), fixed64(3, 9)]);
  const f = parseMessage(buf);
  assert.deepEqual(f.map((x) => [x.fn, x.wt]), [[1, 0], [2, 2], [3, 1]]);
  assert.equal(f[0].value, 7n);
  assert.equal(buf.subarray(f[1].start, f[1].end).toString(), 'hi');
  assert.equal(f[2].u64, 9n);
  assert.throws(() => parseMessage(Buffer.from([0x00])), /invalid field number/);
  assert.throws(() => parseMessage(Buffer.from([0x0b])), /unsupported wire type/);
  assert.throws(() => parseMessage(Buffer.from([0x12, 0x05, 0x00])), /overran/);
});

test('units', () => {
  const buf = Buffer.concat([
    msg(1, id(1, 0xabc, 0xdef), int(2, 12), int(3, 450), double(5, 0.12345), int(6, 900), int(7, 3), int(8, 5), msg(9, int(1, 2), int(2, 3)), int(10, 40)),
    msg(1, int(2, 1)), // no id: dropped
  ]);
  assert.deepEqual(parseUnits(buf), [{
    id: hexId(0xabc, 0xdef), level: 12, xp: 450, xpNeeded: 900, xpLevel: 3, bonus: 5, talents: 2, rarity: 3, stars: 40, xpWeight: 0.123,
  }]);
  assert.deepEqual(parseUnits(Buffer.alloc(0)), []);
});

test('currencies: balance and lifetime merged per id', () => {
  const buf = Buffer.concat([
    msg(1, id(1, 1, 2), int(2, 250)),
    msg(4, id(1, 1, 2), int(2, 9000)),
    msg(1, id(1, 3, 4), int(2, 5)),
  ]);
  assert.deepEqual(parseCurrencies(buf), [
    { id: hexId(1, 2), balance: 250, lifetime: 9000 },
    { id: hexId(3, 4), balance: 5, lifetime: 0 },
  ]);
});

test('owned avatars are unique', () => {
  const buf = Buffer.concat([msg(1, id(1, 5, 6), int(2, 2)), msg(1, id(1, 5, 6), int(2, 3)), msg(1, id(1, 7, 8), int(2, 2))]);
  assert.deepEqual(parseOwnedAvatars(buf), [hexId(5, 6), hexId(7, 8)]);
});

test('game build', () => {
  assert.equal(parseGameBuild(msg(1, str(3, '16.1.2.119766.dp-live'))), '16.1.2.119766');
  assert.equal(parseGameBuild(msg(1, str(3, 'unknown'))), null);
  assert.equal(parseGameBuild(null), null);
  assert.ok(compareBuilds('16.1.2.119766', '16.1.10.1') < 0);
  assert.ok(compareBuilds('16.2.0.1', '16.1.9.9') > 0);
  assert.equal(compareBuilds('16.1.2', '16.1.2.0'), 0);
});
