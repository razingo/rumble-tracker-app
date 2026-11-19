// Minimal schema-less protobuf reader.

export function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    if (pos >= buf.length) throw new Error('varint runs past end of buffer');
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [result, pos];
}

/** Parses one message level into a flat list of fields. */
export function parseMessage(buf, start = 0, end = buf.length) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (fn === 0) throw new Error(`invalid field number at byte ${pos}`);
    switch (wt) {
      case 0: {
        let v;
        [v, pos] = readVarint(buf, pos);
        fields.push({ fn, wt, value: v });
        break;
      }
      case 1:
        fields.push({ fn, wt, u64: buf.readBigUInt64LE(pos), f64: buf.readDoubleLE(pos) });
        pos += 8;
        break;
      case 5:
        fields.push({ fn, wt, u32: buf.readUInt32LE(pos) });
        pos += 4;
        break;
      case 2: {
        let len;
        [len, pos] = readVarint(buf, pos);
        const n = Number(len);
        fields.push({ fn, wt, start: pos, end: pos + n });
        pos += n;
        break;
      }
      default:
        throw new Error(`unsupported wire type ${wt} at byte ${pos}`);
    }
  }
  if (pos !== end) throw new Error('message overran its bounds');
  return fields;
}

export const sub = (buf, field) => parseMessage(buf, field.start, field.end);
export const first = (fields, fn) => fields.find((f) => f.fn === fn);
export const num = (field) => (field && field.value !== undefined ? Number(field.value) : 0);

/** IDs: a message of two fixed64s, sometimes wrapped in another message. */
export function readId(buf, field) {
  let cur = field;
  for (let depth = 0; cur && cur.wt === 2 && depth < 4; depth++) {
    const fields = sub(buf, cur);
    const a = fields.find((f) => f.fn === 1 && f.wt === 1);
    const b = fields.find((f) => f.fn === 2 && f.wt === 1);
    if (a && b) return a.u64.toString(16).padStart(16, '0') + b.u64.toString(16).padStart(16, '0');
    cur = fields.find((f) => f.wt === 2);
  }
  return '';
}
