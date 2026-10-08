import { open, type FileHandle } from 'fs/promises';

// Keep in sync with renderer.ts DTYPE_SIZE.
const DTYPE_SIZE: Record<string, number> = {
  BOOL: 1,
  U8: 1,
  I8: 1,
  F8_E4M3: 1,
  F8_E5M2: 1,
  U16: 2,
  I16: 2,
  F16: 2,
  BF16: 2,
  U32: 4,
  I32: 4,
  F32: 4,
  U64: 8,
  I64: 8,
  F64: 8,
};

interface HeaderEntry {
  dtype?: unknown;
  shape?: unknown;
  data_offsets?: unknown;
}

export interface ParsedFile {
  fh: FileHandle;
  info: FileInfo;
}

function skipWs(buf: Buffer, index: number): number {
  while (index < buf.length) {
    const byte = buf[index] ?? 0;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break;
    index++;
  }
  return index;
}

function previewString(text: string): string {
  const shown = text.length > 120 ? text.slice(0, 118) + '…' : text;
  return JSON.stringify(shown);
}

interface Scanned {
  node: JsonNode;
  next: number;
}

function scanRawString(buf: Buffer, index: number): { text: string; start: number; next: number } {
  if (buf[index] !== 0x22) throw new Error('JSON 字符串无效');
  const start = index;
  let cursor = index + 1;
  while (cursor < buf.length) {
    const byte = buf[cursor] ?? 0;
    if (byte === 0x5c) {
      cursor += 2;
      continue;
    }
    if (byte === 0x22) {
      const text = JSON.parse(buf.toString('utf8', start, cursor + 1)) as string;
      return { text, start, next: cursor + 1 };
    }
    cursor++;
  }
  throw new Error('JSON 字符串未结束');
}

function scanLiteral(buf: Buffer, index: number, base: number, word: string, type: JsonNode['type'], text: string): Scanned {
  if (buf.toString('utf8', index, index + word.length) !== word) throw new Error('JSON 字面量无效');
  return {
    next: index + word.length,
    node: { key: '', type, start: base + index, end: base + index + word.length, text },
  };
}

function scanNumber(buf: Buffer, index: number, base: number): Scanned {
  let cursor = index;
  while (cursor < buf.length) {
    const byte = buf[cursor] ?? 0;
    const ok = (byte >= 0x30 && byte <= 0x39) || byte === 0x2e || byte === 0x2d || byte === 0x2b || byte === 0x65 || byte === 0x45;
    if (!ok) break;
    cursor++;
  }
  if (cursor === index) throw new Error('JSON 数字无效');
  return {
    next: cursor,
    node: { key: '', type: 'number', start: base + index, end: base + cursor, text: buf.toString('utf8', index, cursor) },
  };
}

function scanValue(buf: Buffer, index: number, base: number): Scanned {
  index = skipWs(buf, index);
  const byte = buf[index] ?? 0;
  if (byte === 0x7b) return scanObject(buf, index, base);
  if (byte === 0x5b) return scanArray(buf, index, base);
  if (byte === 0x22) {
    const raw = scanRawString(buf, index);
    return {
      next: raw.next,
      node: { key: '', type: 'string', start: base + raw.start, end: base + raw.next, text: previewString(raw.text) },
    };
  }
  if (byte === 0x74) return scanLiteral(buf, index, base, 'true', 'bool', 'true');
  if (byte === 0x66) return scanLiteral(buf, index, base, 'false', 'bool', 'false');
  if (byte === 0x6e) return scanLiteral(buf, index, base, 'null', 'null', 'null');
  return scanNumber(buf, index, base);
}

function scanObject(buf: Buffer, index: number, base: number): Scanned {
  const start = base + index;
  let cursor = index + 1;
  const children: JsonNode[] = [];
  cursor = skipWs(buf, cursor);
  if ((buf[cursor] ?? 0) !== 0x7d) {
    while (cursor < buf.length) {
      cursor = skipWs(buf, cursor);
      const key = scanRawString(buf, cursor);
      cursor = skipWs(buf, key.next);
      if ((buf[cursor] ?? 0) !== 0x3a) throw new Error('JSON 缺少冒号');
      const value = scanValue(buf, cursor + 1, base);
      value.node.key = key.text;
      value.node.start = base + key.start;
      children.push(value.node);
      cursor = skipWs(buf, value.next);
      const mark = buf[cursor] ?? 0;
      if (mark === 0x2c) {
        cursor++;
        continue;
      }
      if (mark === 0x7d) break;
      throw new Error('JSON 对象未结束');
    }
  }
  if ((buf[cursor] ?? 0) !== 0x7d) throw new Error('JSON 对象未结束');
  return {
    next: cursor + 1,
    node: { key: '', type: 'object', start, end: base + cursor + 1, text: '{' + children.length + '}', children },
  };
}

function scanArray(buf: Buffer, index: number, base: number): Scanned {
  const start = base + index;
  let cursor = index + 1;
  const children: JsonNode[] = [];
  cursor = skipWs(buf, cursor);
  if ((buf[cursor] ?? 0) !== 0x5d) {
    while (cursor < buf.length) {
      const value = scanValue(buf, cursor, base);
      value.node.key = '[' + children.length + ']';
      children.push(value.node);
      cursor = skipWs(buf, value.next);
      const mark = buf[cursor] ?? 0;
      if (mark === 0x2c) {
        cursor++;
        continue;
      }
      if (mark === 0x5d) break;
      throw new Error('JSON 数组未结束');
    }
  }
  if ((buf[cursor] ?? 0) !== 0x5d) throw new Error('JSON 数组未结束');
  return {
    next: cursor + 1,
    node: { key: '', type: 'array', start, end: base + cursor + 1, text: '[' + children.length + ']', children },
  };
}

function isTensorObject(node: JsonNode): boolean {
  if (node.type !== 'object' || !node.children) return false;
  const dtype = node.children.find((child) => child.key === 'dtype');
  const shape = node.children.find((child) => child.key === 'shape');
  const offsets = node.children.find((child) => child.key === 'data_offsets');
  return dtype?.type === 'string' && shape?.type === 'array' && offsets?.type === 'array';
}

// Format rules mark values that point at file bytes. Safetensors tensor data_offsets are relative to the data section.
function linkFormatOffsets(root: JsonNode, dataStart: number): void {
  const visit = (node: JsonNode, ancestors: JsonNode[]): void => {
    const array = ancestors[ancestors.length - 1];
    const owner = ancestors[ancestors.length - 2];
    if (node.type === 'number' && array?.type === 'array' && array.key === 'data_offsets' && owner && isTensorObject(owner)) {
      const rel = Number(node.text);
      if (Number.isFinite(rel)) {
        node.base = dataStart;
        node.offset = rel;
        node.target = dataStart + rel;
      }
    }
    const next = ancestors.concat(node);
    for (const child of node.children ?? []) visit(child, next);
  };
  visit(root, []);
}

function buildHeaderTree(buf: Buffer, base: number, end: number): JsonNode {
  try {
    const scanned = scanValue(buf, 0, base);
    scanned.node.key = 'header_json';
    return scanned.node;
  } catch {
    return { key: 'header_json', type: 'object', start: base, end, text: '?', children: [] };
  }
}

async function readExact(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await fh.read(buf, off, buf.length - off, position + off);
    if (bytesRead === 0) throw new Error('意外的文件结尾');
    off += bytesRead;
  }
}

function normalizeMetadata(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = typeof item === 'string' ? item : JSON.stringify(item);
  }
  return out;
}

function asShape(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((dim) => (typeof dim === 'number' ? dim : Number.NaN));
}

function inspectTensor(name: string, value: unknown, dataStart: number, fileSize: number): TensorInfo {
  const flags: string[] = [];
  const entry = value && typeof value === 'object' ? value as HeaderEntry : null;
  const dtype = String(entry && entry.dtype != null ? entry.dtype : '?').toUpperCase();
  const shape = asShape(entry ? entry.shape : null);
  const offsets = entry && Array.isArray(entry.data_offsets) ? entry.data_offsets : null;
  const relStart = offsets ? offsets[0] : null;
  const relEnd = offsets ? offsets[1] : null;
  const badOff = typeof relStart !== 'number'
    || typeof relEnd !== 'number'
    || !Number.isInteger(relStart)
    || !Number.isInteger(relEnd)
    || relStart < 0
    || relEnd < relStart;
  if (!entry) flags.push('bad-entry');
  if (badOff) flags.push('bad-offsets');

  const start = badOff ? dataStart : dataStart + relStart;
  const end = badOff ? dataStart : dataStart + relEnd;
  const bytes = badOff ? 0 : relEnd - relStart;
  const itemSize = DTYPE_SIZE[dtype] || 0;
  const dataSize = fileSize - dataStart;

  if (!badOff && (relStart > dataSize || relEnd > dataSize || start < dataStart)) {
    flags.push('out-of-range');
  }
  if (!badOff && relStart % 8 !== 0) flags.push('unaligned');

  if (!itemSize) {
    flags.push('unknown-dtype');
  } else {
    let count = 1n;
    let shapeOk = true;
    for (const dim of shape) {
      if (!Number.isSafeInteger(dim) || dim < 0) {
        shapeOk = false;
        break;
      }
      count *= BigInt(dim);
    }
    if (!shapeOk) flags.push('bad-shape');
    else if (!badOff && count * BigInt(itemSize) !== BigInt(bytes)) flags.push('size-mismatch');
  }

  return {
    name,
    dtype,
    shape,
    itemSize,
    start,
    end,
    bytes,
    relStart: badOff ? null : relStart,
    relEnd: badOff ? null : relEnd,
    flags,
  };
}

async function readInfo(fh: FileHandle, filePath: string, fileSize: number): Promise<FileInfo> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 8) {
    throw new Error('文件过小，不是 safetensors');
  }
  const lenBuf = Buffer.alloc(8);
  await readExact(fh, lenBuf, 0);
  const headerSizeBig = lenBuf.readBigUInt64LE(0);
  if (headerSizeBig <= 1n || headerSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('头长度异常');
  }
  const headerSize = Number(headerSizeBig);
  if (headerSize > fileSize - 8) throw new Error('头长度与文件大小不符');
  if (headerSize > 512 * 1024 * 1024) throw new Error('头过大');

  const headerBuf = Buffer.alloc(headerSize);
  await readExact(fh, headerBuf, 8);
  let json: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(headerBuf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('头必须是 JSON 对象');
    }
    json = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && err.message === '头必须是 JSON 对象') throw err;
    throw new Error('头 JSON 无法解析，可能不是 safetensors');
  }

  const dataStart = 8 + headerSize;
  const headerTree = buildHeaderTree(headerBuf, 8, dataStart);
  linkFormatOffsets(headerTree, dataStart);
  const metadata = normalizeMetadata(json.__metadata__);
  const tensors: TensorInfo[] = [];
  for (const [name, value] of Object.entries(json)) {
    if (name === '__metadata__') continue;
    tensors.push(inspectTensor(name, value, dataStart, fileSize));
  }
  tensors.sort((a, b) => a.start - b.start || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < tensors.length; i++) {
    const current = tensors[i];
    const previous = tensors[i - 1];
    if (!current || !previous) continue;
    if (current.start < previous.end) {
      if (!current.flags.includes('overlap')) current.flags.push('overlap');
      if (!previous.flags.includes('overlap')) previous.flags.push('overlap');
    }
  }

  let dataEnd = dataStart;
  for (const tensor of tensors) dataEnd = Math.max(dataEnd, Math.min(tensor.end, fileSize));
  return {
    filePath,
    fileSize,
    headerSize,
    dataStart,
    trailing: fileSize - dataEnd,
    metadata,
    headerTree,
    tensors,
    warnCount: tensors.filter((tensor) => tensor.flags.length).length,
  };
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
  const fh = await open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const info = await readInfo(fh, filePath, stat.size);
    return { fh, info };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}
