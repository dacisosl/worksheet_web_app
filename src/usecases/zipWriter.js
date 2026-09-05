// zipWriter — 의존성 0 의 최소 ZIP 라이터(저장 방식, 무압축). 순수 함수(FS/DOM 무접촉).
//
// DOCX(OOXML)·HWPX 는 ZIP 컨테이너다. 브라우저에는 ZIP 라이터가 없고, 이 프로젝트는 외부 의존성을
// 두지 않는다. 그래서 필요한 최소만 직접 쓴다 — 항목마다 CRC-32 를 계산해 저장(method 0)으로 담는다.
// 압축을 하지 않는 이유: 활동지 XML 은 수십 KB 라 압축 없이도 작고, 압축은 CompressionStream 같은
// 플랫폼 API 나 라이브러리를 끌어들인다. 워드·한글은 저장 방식 항목을 문제없이 연다.
//
// 결정적 산출물: 날짜·시간을 고정값으로 쓴다(같은 입력 → 같은 바이트, 프로젝트 관례).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Uint8Array} bytes @returns {number} */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const encoder = new TextEncoder();
/** 문자열이면 UTF-8 로, Uint8Array 면 그대로. */
function toBytes(data) {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

// DOS 시간/날짜(고정: 2026-01-01 00:00) — 결정적 산출물.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function u16(view, off, v) { view.setUint16(off, v, true); }
function u32(view, off, v) { view.setUint32(off, v >>> 0, true); }

/**
 * @param {Array<{name:string, data:string|Uint8Array}>} entries 항목 순서 그대로 기록한다
 *   (OOXML 은 `[Content_Types].xml` 이 첫 항목인 것이 관례다 — 호출부가 순서를 정한다).
 * @returns {Uint8Array} ZIP 바이트
 */
export function writeZip(entries) {
  if (!Array.isArray(entries)) throw new TypeError('writeZip 은 entries 배열이 필요합니다.');
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) throw new TypeError('ZIP 항목에는 name 이 필요합니다.');
    const name = encoder.encode(entry.name);
    const data = toBytes(entry.data ?? '');
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034B50);   // local file header
    u16(lv, 4, 20);           // version needed
    u16(lv, 6, 0x0800);       // flags: UTF-8 names
    u16(lv, 8, 0);            // method: stored
    u16(lv, 10, DOS_TIME);
    u16(lv, 12, DOS_DATE);
    u32(lv, 14, crc);
    u32(lv, 18, data.length);
    u32(lv, 22, data.length);
    u16(lv, 26, name.length);
    u16(lv, 28, 0);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014B50);   // central directory header
    u16(cv, 4, 20);           // version made by
    u16(cv, 6, 20);           // version needed
    u16(cv, 8, 0x0800);
    u16(cv, 10, 0);
    u16(cv, 12, DOS_TIME);
    u16(cv, 14, DOS_DATE);
    u32(cv, 16, crc);
    u32(cv, 20, data.length);
    u32(cv, 24, data.length);
    u16(cv, 28, name.length);
    u16(cv, 30, 0);           // extra
    u16(cv, 32, 0);           // comment
    u16(cv, 34, 0);           // disk
    u16(cv, 36, 0);           // internal attrs
    u32(cv, 38, 0);           // external attrs
    u32(cv, 42, offset);      // local header offset
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  u32(ev, 0, 0x06054B50);
  u16(ev, 4, 0);
  u16(ev, 6, 0);
  u16(ev, 8, entries.length);
  u16(ev, 10, entries.length);
  u32(ev, 12, cdSize);
  u32(ev, 16, offset);
  u16(ev, 20, 0);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...locals, ...centrals, eocd]) { out.set(part, pos); pos += part.length; }
  return out;
}
