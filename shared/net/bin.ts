export class BinWriter {
  private buf = new Uint8Array(1024);
  private dv = new DataView(this.buf.buffer);
  len = 0;

  private need(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  u8(v: number) {
    this.need(1);
    this.buf[this.len++] = v & 0xff;
  }
  i8(v: number) {
    this.need(1);
    this.dv.setInt8(this.len++, v);
  }
  u16(v: number) {
    this.need(2);
    this.dv.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
  }
  i16(v: number) {
    this.need(2);
    this.dv.setInt16(this.len, Math.max(-32768, Math.min(32767, v)), true);
    this.len += 2;
  }
  u32(v: number) {
    this.need(4);
    this.dv.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }
  f32(v: number) {
    this.need(4);
    this.dv.setFloat32(this.len, v, true);
    this.len += 4;
  }
  f64(v: number) {
    this.need(8);
    this.dv.setFloat64(this.len, v, true);
    this.len += 8;
  }
  /** Unsigned LEB128. */
  uv(v: number) {
    v = Math.max(0, Math.floor(v));
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b |= 0x80;
      this.u8(b);
    } while (v > 0);
  }
  bytes(b: Uint8Array) {
    this.uv(b.length);
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class BinReader {
  private dv: DataView;
  pos = 0;
  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get left() {
    return this.buf.length - this.pos;
  }
  u8() {
    return this.buf[this.pos++];
  }
  i8() {
    return this.dv.getInt8(this.pos++);
  }
  u16() {
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16() {
    const v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  uv() {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = this.u8();
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 128;
    }
  }
  bytes(): Uint8Array {
    const n = this.uv();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}
