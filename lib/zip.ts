/**
 * Minimal ZIP reader/writer — just enough for the project-memory archive
 * ("把某个项目的记忆导出成一个压缩包，在另一台机器导入").
 *
 * Why hand-rolled instead of a dependency: this plugin ships as a prebuilt
 * package into `<profile>/node_modules`, and every extra runtime dependency is
 * one more thing `dsh plugin add` installs and the host must resolve. A zip is
 * a plain container (local headers + central directory + EOCD) and Node's
 * `zlib` already provides the only hard part (raw deflate), so ~200 lines here
 * replace a whole dependency tree.
 *
 * Scope, deliberately narrow:
 *  - STORE (0) and DEFLATE (8) only — what every zip tool writes by default;
 *  - no zip64 (archives are capped at a few MB, see `ZipLimits`);
 *  - reading validates CRC32 and enforces entry-count / per-entry / total-size
 *    caps, so a hostile "bomb" archive cannot exhaust memory;
 *  - path hygiene is NOT this module's job: it returns entry names verbatim
 *    and `project-archive.ts` runs them through `safeMemoryRel`.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** One file to put into a new archive. */
export interface ZipEntryInput {
  /** Entry name with forward slashes, e.g. `memory/overview.md`. */
  name: string;
  data: Buffer | string;
  /** Modification time stored in the header (defaults to now). */
  mtime?: Date;
}

/** One file read out of an archive. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Caps applied while READING an archive (all optional, sane defaults). */
export interface ZipLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** General purpose bit 11: entry names are UTF-8 rather than CP437. */
const FLAG_UTF8 = 0x0800;
const EOCD_MIN_SIZE = 22;
/** Largest possible EOCD tail: fixed part + a 64 KiB comment. */
const MAX_EOCD_TAIL = EOCD_MIN_SIZE + 0xffff;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3), the checksum zip stores per entry. */
function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP stores timestamps as two packed DOS words, not an epoch. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/**
 * Build a zip archive in memory.
 *
 * Each entry is deflated when that actually shrinks it, stored otherwise
 * (markdown compresses well; already-small files stay readable in a hex dump).
 *
 * @throws when an entry is too large for the 32-bit header fields
 */
export function createZip(entries: readonly ZipEntryInput[]): Buffer {
  if (entries.length > MAX_U16) throw new Error(`压缩包条目过多（${entries.length} > ${MAX_U16}）`);
  const now = new Date();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    if (nameBuf.length > MAX_U16) throw new Error(`文件名过长：${entry.name}`);
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    if (raw.length > MAX_U32) throw new Error(`文件过大：${entry.name}`);
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { time, date } = dosDateTime(entry.mtime ?? now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuf, body);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(EOCD_MIN_SIZE);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/**
 * Read every file out of a zip archive.
 *
 * Directory entries are skipped. Entry names are returned verbatim (the caller
 * gates them); sizes and CRCs are enforced here so a malformed or crafted
 * archive fails loudly instead of producing silent garbage.
 *
 * @throws Error with a Chinese, user-readable reason
 */
export function readZip(buf: Buffer, limits: ZipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 500;
  const maxEntryBytes = limits.maxEntryBytes ?? 4 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 32 * 1024 * 1024;

  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN_SIZE) {
    throw new Error('不是有效的 zip 压缩包（文件太小）');
  }

  // The EOCD sits at the very end, but may be preceded by a comment; scan
  // backwards from the tail rather than assuming a fixed offset.
  let eocd = -1;
  const floor = Math.max(0, buf.length - MAX_EOCD_TAIL);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 压缩包（找不到目录尾）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === MAX_U16 || cdOffset === MAX_U32 || cdSize === MAX_U32) {
    throw new Error('不支持 zip64 压缩包：请按普通 zip 重新导出');
  }
  if (count > maxEntries) throw new Error(`压缩包条目过多（${count} > ${maxEntries}）`);
  if (cdOffset + cdSize > buf.length) throw new Error('zip 目录越界，文件可能已损坏');

  const out: ZipEntry[] = [];
  let total = 0;
  let offset = cdOffset;

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('zip 目录项损坏');
    }
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (size > maxEntryBytes) throw new Error(`压缩包内文件过大：${name}（${size} 字节 > ${maxEntryBytes}）`);
    total += size;
    if (total > maxTotalBytes) throw new Error(`压缩包解压后总大小超限（> ${maxTotalBytes} 字节）`);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 本地头损坏：${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compressedSize > buf.length) throw new Error(`zip 数据越界：${name}`);

    const raw = buf.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        // maxOutputLength turns a deflate bomb into an error, not an OOM.
        data = inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      } catch {
        throw new Error(`解压失败：${name}`);
      }
    } else {
      throw new Error(`不支持的压缩方式 ${method}：${name}`);
    }
    if (data.length !== size) throw new Error(`解压后大小不符：${name}（${data.length} ≠ ${size}）`);
    if (crc32(data) !== crc) throw new Error(`CRC 校验失败：${name}`);
    out.push({ name, data });
  }

  return out;
}
