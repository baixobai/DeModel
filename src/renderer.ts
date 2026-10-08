// Keep in sync with parse.ts DTYPE_SIZE.
const DTYPE_SIZE: Record<string, number> = {
  BOOL: 1, U8: 1, I8: 1, F8_E4M3: 1, F8_E5M2: 1,
  U16: 2, I16: 2, F16: 2, BF16: 2,
  U32: 4, I32: 4, F32: 4,
  U64: 8, I64: 8, F64: 8,
};

const FLAG_TEXT: Record<string, string> = {
  'bad-entry': '条目无效',
  'bad-offsets': '偏移无效',
  'unknown-dtype': '未知dtype',
  'bad-shape': '形状无效',
  'size-mismatch': '长度与shape不符',
  'out-of-range': '超出文件',
  unaligned: '起点未按8字节对齐',
  overlap: '重叠',
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));
const CACHE = 256 * 1024;

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('missing #' + id);
  return node as T;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const pathEl = must<HTMLDivElement>('path');
const menuFile = must<HTMLButtonElement>('menu-file');
const menuEdit = must<HTMLButtonElement>('menu-edit');
const menuView = must<HTMLButtonElement>('menu-view');
const appMenu = must<HTMLDivElement>('app-menu');
const appSub = must<HTMLDivElement>('app-sub');
const ctxMenu = must<HTMLDivElement>('ctx');
const hintPop = must<HTMLDivElement>('hint-pop');
const gotoInput = must<HTMLInputElement>('goto');
const jView = must<HTMLDivElement>('j-view');
const jBar = must<HTMLDivElement>('j-bar');
const jThumb = must<HTMLDivElement>('j-thumb');
const filterInput = must<HTMLInputElement>('filter');
const binInput = must<HTMLInputElement>('bin-search');
const side = must<HTMLElement>('side');
const split = must<HTMLDivElement>('split');
const hexHead = must<HTMLDivElement>('hex-head');
const hexView = must<HTMLDivElement>('hex-view');
const hexBar = must<HTMLDivElement>('hex-bar');
const hexMark = must<HTMLDivElement>('hex-mark');
const hexThumb = must<HTMLDivElement>('hex-thumb');
const insLoc = must<HTMLDivElement>('ins-loc');
const insSel = must<HTMLDivElement>('ins-sel');
const insAddr = must<HTMLDivElement>('ins-addr');
const chipRadixBox = must<HTMLDivElement>('chip-radix');
const chipUnitBox = must<HTMLDivElement>('chip-unit');
const insVals = must<HTMLDivElement>('ins-vals');

interface ByteCache { start: number; bytes: Uint8Array }
interface ByteRange { start: number; end: number; label: string }
interface ThumbDrag { y: number; scroll: number; pointer: number }

let info: FileInfo | null = null;
let treeRoot: JsonNode | null = null;
let binFrom = 0;
let radix: 10 | 16 = 16;
let showFieldHelp = false;
let chipRadix: 10 | 16 = 10;
let chipUnit = 'U8';
let fileSize = 0;
let cache: ByteCache | null = null;
let cache2: ByteCache | null = null;
const inflight = new Map<string, Promise<ReadResult>>();
let fileGen = 0;
let paintGen = 0;
let inspGen = 0;
let lastPaint: { offset: number; bytes: Uint8Array<ArrayBufferLike> } | null = null;
let cursor = 0;
let anchor = 0;
let selection: ByteRange = { start: 0, end: 0, label: '' };
let selectedName = '';
let selectedJsonPath = '';
let flatJson: FlatJson[] = [];
const jsonExpanded = new Set<string>(['']);

interface FlatJson {
  node: JsonNode;
  depth: number;
  path: string;
  hasChildren: boolean;
  open: boolean;
  help: string;
}
let hexScheduled = false;
let dragOn = false;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let loadToken = 0;
let inspScheduled = false;

// Native scroll height cannot represent multi-GB files (about 33M px).
// The thumb maps a ratio onto a row index; only the visible window is read.
class VirtualList {
  count = 0;
  scroll = 0;
  drag: ThumbDrag | null = null;

  constructor(
    private root: HTMLElement,
    private track: HTMLElement,
    private thumb: HTMLElement,
    private rowHeight: number,
    private onScroll: () => void,
  ) {
    this.track.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.track.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.track.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.track.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.root.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.updateThumb();
  }

  visible() {
    const height = this.root.clientHeight;
    if (height <= 0) return 1;
    return Math.max(1, Math.ceil(height / this.rowHeight));
  }

  maxScroll() {
    return Math.max(0, this.count - this.visible());
  }

  setCount(count: number): void {
    this.count = Math.max(0, count);
    const max = this.maxScroll();
    if (this.scroll > max) this.scroll = max;
    this.updateThumb();
    this.onScroll();
  }

  scrollBy(rows: number): boolean {
    return this.scrollTo(this.scroll + rows);
  }

  scrollTo(row: number): boolean {
    const next = Math.max(0, Math.min(this.maxScroll(), row));
    if (next === this.scroll) {
      this.updateThumb();
      return false;
    }
    this.scroll = next;
    this.updateThumb();
    this.onScroll();
    return true;
  }

  scrollToIndex(index: number): boolean {
    const vis = this.visible();
    return this.scrollTo(index - Math.floor(vis * 0.25));
  }

  updateThumb() {
    const max = this.maxScroll();
    this.track.classList.toggle('off', max <= 0);
    const trackH = this.track.clientHeight || 1;
    const vis = this.visible();
    const height = this.count <= 0 ? trackH : Math.max(18, Math.min(trackH, trackH * (vis / this.count)));
    const maxTop = Math.max(0, trackH - height);
    const top = max === 0 ? 0 : (this.scroll / max) * maxTop;
    this.thumb.style.height = height + 'px';
    this.thumb.style.transform = 'translateY(' + top + 'px)';
  }

  onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const onThumb = e.target === this.thumb;
    if (onThumb) {
      this.drag = { y: e.clientY, scroll: this.scroll, pointer: e.pointerId };
      this.thumb.setPointerCapture(e.pointerId);
      return;
    }
    const rect = this.track.getBoundingClientRect();
    const ratio = rect.height ? (e.clientY - rect.top) / rect.height : 0;
    this.scrollTo(ratio * this.maxScroll());
  }

  onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.pointer) return;
    const trackH = this.track.clientHeight;
    const thumbH = this.thumb.clientHeight;
    const maxTop = Math.max(1, trackH - thumbH);
    const dy = e.clientY - this.drag.y;
    this.scrollTo(this.drag.scroll + (dy / maxTop) * this.maxScroll());
  }

  onPointerUp(e: PointerEvent): void {
    if (this.drag && e.pointerId === this.drag.pointer) this.drag = null;
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= this.rowHeight;
    if (e.deltaMode === 2) delta *= this.root.clientHeight || 1;
    const dir = Math.sign(delta);
    if (!dir) return;
    if (e.ctrlKey) {
      this.scrollBy(dir * this.visible());
      return;
    }
    if (e.altKey) {
      this.scrollBy(dir * Math.max(1, Math.round(this.maxScroll() * 0.02)));
      return;
    }
    let rows = Math.max(1, Math.ceil(Math.abs(delta) / 40));
    if (e.shiftKey) rows *= 20;
    this.scrollBy(dir * rows);
  }
}

const hexList = new VirtualList(hexView, hexBar, hexThumb, 20, () => scheduleHexPaint());
const jsonList = new VirtualList(jView, jBar, jThumb, 22, () => renderJsonTree());

function fmtSize(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '?';
  n = Math.max(0, n);
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(digits) + ' ' + units[index];
}

function addrChars(): number {
  if (radix === 10) return Math.max(4, String(Math.max(0, fileSize)).length);
  return fileSize > 0xffffffff ? 12 : 8;
}

function applyAddrWidth(): void {
  const extra = radix === 16 ? 2 : 0;
  document.documentElement.style.setProperty('--addr-w', (addrChars() + extra) + 'ch');
}

function fmtInt(n: number): string {
  const value = Math.trunc(n);
  if (radix === 10) return value.toLocaleString();
  const sign = value < 0 ? '-' : '';
  return sign + '0x' + Math.abs(value).toString(16).toUpperCase();
}

function shownValue(node: JsonNode): string {
  if (node.type === 'object' || node.type === 'array') return ' ' + node.text;
  if (/^-?\d+$/.test(node.text)) {
    const text = fmtInt(Number(node.text));
    return node.key === 'header_len' ? ': u64le ' + text : ': ' + text;
  }
  return ': ' + node.text;
}

function fmtOff(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '?';
  const value = Math.trunc(n);
  if (radix === 10) return value.toLocaleString();
  return '0x' + value.toString(16).toUpperCase().padStart(addrChars(), '0');
}

function addrText(n: number): string {
  const value = Math.trunc(n);
  if (radix === 10) return value.toString().padStart(addrChars(), ' ');
  return value.toString(16).toUpperCase().padStart(addrChars(), '0');
}

function fmtFloat(value: number | bigint | string): string {
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e7)) return value.toExponential(4);
  let text = value.toFixed(6);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

function shapeStr(shape: number[] | null | undefined, limit: number): string {
  const text = (shape || []).join('×');
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + '…';
}

function decodeF16(u: number): number {
  const sign = (u & 0x8000) ? -1 : 1;
  const exp = (u >> 10) & 0x1f;
  const mant = u & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

function decodeBf16(u: number): number {
  const u32 = new Uint32Array(1);
  const f32 = new Float32Array(u32.buffer);
  u32[0] = u << 16;
  return f32[0];
}

function decodeF8E4M3(u: number): number {
  const sign = (u & 0x80) ? -1 : 1;
  const exp = (u >> 3) & 0x0f;
  const mant = u & 0x07;
  if (exp === 0) return sign * 2 ** -6 * (mant / 8);
  if (exp === 15) return mant === 7 ? NaN : sign * 2 ** 8 * (1 + mant / 8);
  return sign * 2 ** (exp - 7) * (1 + mant / 8);
}

function decodeF8E5M2(u: number): number {
  const sign = (u & 0x80) ? -1 : 1;
  const exp = (u >> 2) & 0x1f;
  const mant = u & 0x03;
  if (exp === 0) return sign * 2 ** -14 * (mant / 4);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 4);
}

function readAt(dv: DataView, offset: number, dtype: string): number | bigint | null {
  switch (dtype) {
    case 'BOOL': return dv.getUint8(offset) ? 1 : 0;
    case 'U8': return dv.getUint8(offset);
    case 'I8': return dv.getInt8(offset);
    case 'F8_E4M3': return decodeF8E4M3(dv.getUint8(offset));
    case 'F8_E5M2': return decodeF8E5M2(dv.getUint8(offset));
    case 'U16': return dv.getUint16(offset, true);
    case 'I16': return dv.getInt16(offset, true);
    case 'F16': return decodeF16(dv.getUint16(offset, true));
    case 'BF16': return decodeBf16(dv.getUint16(offset, true));
    case 'U32': return dv.getUint32(offset, true);
    case 'I32': return dv.getInt32(offset, true);
    case 'F32': return dv.getFloat32(offset, true);
    case 'U64': return dv.getBigUint64(offset, true);
    case 'I64': return dv.getBigInt64(offset, true);
    case 'F64': return dv.getFloat64(offset, true);
    default: return null;
  }
}

function decodeList(u8: Uint8Array<ArrayBufferLike>, dtype: string, itemSize: number, maxCount: number): Array<number | bigint | null> {
  const count = Math.min(maxCount, Math.floor(u8.length / itemSize));
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (let i = 0; i < count; i++) out.push(readAt(view, i * itemSize, dtype));
  return out;
}

function toU8(bytes: unknown): Uint8Array<ArrayBufferLike> {
  if (bytes instanceof Uint8Array) return bytes;
  if (Array.isArray(bytes)) return Uint8Array.from(bytes as number[]);
  if (bytes && typeof bytes === 'object' && 'data' in bytes && Array.isArray(bytes.data)) {
    return Uint8Array.from(bytes.data as number[]);
  }
  return new Uint8Array(0);
}

function covers(block: ByteCache | null, offset: number, length: number): block is ByteCache {
  return !!block && offset >= block.start && offset + length <= block.start + block.bytes.length;
}

function sliceBlock(block: ByteCache, offset: number, length: number): Uint8Array<ArrayBufferLike> {
  const start = offset - block.start;
  return block.bytes.subarray(start, start + length);
}

function loadBlock(start: number, len: number): Promise<ReadResult> {
  const key = start + ':' + len;
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = window.api.read(start, len).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

function maybePrefetch() {
  if (!cache) return;
  const myFile = fileGen;
  const end = cache.start + cache.bytes.length;
  if (end >= fileSize) return;
  if (cache2 && cache2.start === end) return;
  const len = Math.min(CACHE, fileSize - end);
  loadBlock(end, len).then((res) => {
    if (myFile !== fileGen) return;
    if (!cache || cache.start + cache.bytes.length !== end) return;
    cache2 = { start: res.offset, bytes: toU8(res.bytes) };
  }).catch(() => {});
}

async function readCached(offset: number, length: number): Promise<Uint8Array<ArrayBufferLike>> {
  const myFile = fileGen;
  if (!info || length <= 0 || offset >= fileSize) return new Uint8Array();
  if (offset < 0) offset = 0;
  length = Math.min(length, fileSize - offset);
  const hit = cache;
  if (covers(hit, offset, length)) {
    if (hit.start + hit.bytes.length - (offset + length) < 64 * 1024) maybePrefetch();
    return sliceBlock(hit, offset, length);
  }
  const alt = cache2;
  if (covers(alt, offset, length)) {
    cache = alt;
    cache2 = hit;
    return sliceBlock(alt, offset, length);
  }
  const start = Math.floor(offset / CACHE) * CACHE;
  let len = Math.min(CACHE, fileSize - start);
  if (offset + length > start + len) {
    len = Math.min(1024 * 1024, fileSize - start, offset + length - start);
  }
  const res = await loadBlock(start, len);
  if (myFile !== fileGen) return new Uint8Array();
  const block = { start: res.offset, bytes: toU8(res.bytes) };
  cache2 = cache;
  cache = block;
  if (!covers(cache, offset, length)) {
    const direct = await window.api.read(offset, length);
    if (myFile !== fileGen) return new Uint8Array();
    return toU8(direct.bytes);
  }
  return sliceBlock(cache, offset, length);
}

function findTensor(offset: number): TensorInfo | null {
  const arr = info ? info.tensors : [];
  if (!arr.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= offset) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let i = idx; i >= 0 && i > idx - 32; i--) {
    const tensor = arr[i];
    if (offset >= tensor.start && offset < tensor.end) return tensor;
  }
  return null;
}

function showHexEmpty(text: string): void {
  hexView.replaceChildren();
  const node = document.createElement('div');
  node.className = 'hex-empty';
  node.textContent = text;
  hexView.appendChild(node);
}

function scheduleHexPaint() {
  if (hexScheduled) return;
  hexScheduled = true;
  requestAnimationFrame(() => {
    hexScheduled = false;
    paintHex();
  });
}

function updateMark() {
  if (!info || fileSize <= 0 || !selection || selection.end <= selection.start) {
    hexMark.classList.add('off');
    return;
  }
  const height = hexBar.clientHeight || 1;
  const y1 = (selection.start / fileSize) * height;
  const y2 = (selection.end / fileSize) * height;
  hexMark.classList.remove('off');
  hexMark.style.top = Math.max(0, y1) + 'px';
  hexMark.style.height = Math.max(2, y2 - y1) + 'px';
}

function byteClass(prefix: string, offset: number, value: number): string {
  const parts = [prefix];
  if (value === 0) parts.push('zero');
  if (offset < 8) parts.push('hdr-len');
  else if (info && offset < info.dataStart) parts.push('hdr-json');
  if (offset >= selection.start && offset < selection.end) parts.push('sel');
  if (offset === cursor) parts.push('cur');
  return parts.join(' ');
}

function drawHex(offset: number, bytes: Uint8Array<ArrayBufferLike>): void {
  const frag = document.createDocumentFragment();
  const rowCount = Math.ceil(fileSize / 16);
  const startRow = Math.floor(offset / 16);
  const rows = Math.min(hexList.visible(), Math.max(0, rowCount - startRow));
  for (let r = 0; r < rows; r++) {
    const base = offset + r * 16;
    const row = document.createElement('div');
    row.className = 'row';
    const addr = document.createElement('span');
    addr.className = 'addr';
    addr.textContent = addrText(base);
    const hexs = document.createElement('span');
    hexs.className = 'hexs';
    const asciis = document.createElement('span');
    asciis.className = 'asciis';
    for (let col = 0; col < 16; col++) {
      const fileOff = base + col;
      const index = r * 16 + col;
      const hexSpan = document.createElement('span');
      const asciiSpan = document.createElement('span');
      if (fileOff >= fileSize || index >= bytes.length) {
        hexSpan.className = 'b';
        hexSpan.textContent = '  ';
        asciiSpan.className = 'a';
        asciiSpan.textContent = ' ';
      } else {
        const value = bytes[index];
        hexSpan.className = byteClass('b', fileOff, value);
        hexSpan.dataset.off = String(fileOff);
        hexSpan.textContent = HEX[value];
        asciiSpan.className = byteClass('a', fileOff, value);
        asciiSpan.dataset.off = String(fileOff);
        asciiSpan.textContent = value >= 32 && value <= 126 ? String.fromCharCode(value) : '·';
      }
      hexs.appendChild(hexSpan);
      asciis.appendChild(asciiSpan);
    }
    row.append(addr, hexs, asciis);
    frag.appendChild(row);
  }
  hexView.replaceChildren(frag);
}

let highlightScheduled = false;
function refreshHex() {
  if (highlightScheduled) return;
  highlightScheduled = true;
  requestAnimationFrame(() => {
    highlightScheduled = false;
    if (!lastPaint) {
      scheduleHexPaint();
      updateMark();
      return;
    }
    drawHex(lastPaint.offset, lastPaint.bytes);
    updateMark();
  });
}

async function paintHex() {
  if (!info) return;
  const gen = ++paintGen;
  const myFile = fileGen;
  const rowCount = Math.ceil(fileSize / 16);
  const startRow = Math.floor(hexList.scroll);
  const rows = Math.min(hexList.visible(), Math.max(0, rowCount - startRow));
  const offset = startRow * 16;
  const length = Math.min(rows * 16, Math.max(0, fileSize - offset));
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    if (length > 0) bytes = await readCached(offset, length);
  } catch (err) {
    if (gen !== paintGen || myFile !== fileGen) return;
    showHexEmpty('读取失败: ' + errText(err));
    return;
  }
  if (gen !== paintGen || myFile !== fileGen) return;
  lastPaint = { offset, bytes };
  drawHex(offset, bytes);
  updateMark();
}

function ensureVisible(offset: number): void {
  const row = Math.floor(offset / 16);
  const start = Math.floor(hexList.scroll);
  const vis = Math.max(1, hexList.visible());
  let moved = false;
  if (row < start) moved = hexList.scrollTo(row);
  else if (row >= start + vis) moved = hexList.scrollTo(row - vis + 1);
  if (!moved) refreshHex();
  else updateMark();
}

function renderStructure(): void {
  const file = info;
  if (!file) {
    treeRoot = null;
    return;
  }
  const base = file.filePath.split(/[/\\]/).pop() ?? file.filePath;
  treeRoot = {
    key: base,
    type: 'object',
    start: 0,
    end: file.fileSize,
    text: fmtSize(file.fileSize) + '  张量 ' + file.tensors.length,
    children: [
      { key: 'header_len', type: 'number', start: 0, end: Math.min(8, file.fileSize), text: String(file.headerSize) },
      file.headerTree,
    ],
  };
}

function subtreeMatch(node: JsonNode, query: string): boolean {
  if ((node.key + ' ' + node.text).toLowerCase().includes(query)) return true;
  return (node.children ?? []).some((child) => subtreeMatch(child, query));
}

function isTensorNode(node: JsonNode | null): boolean {
  if (!node || node.type !== 'object' || !node.children) return false;
  const dtype = node.children.find((child) => child.key === 'dtype');
  const shape = node.children.find((child) => child.key === 'shape');
  const offsets = node.children.find((child) => child.key === 'data_offsets');
  return dtype?.type === 'string' && shape?.type === 'array' && offsets?.type === 'array';
}

function fieldHelp(node: JsonNode, parent: JsonNode | null): string {
  if (node.key === 'header_len') return '文件开头 8 字节，小端 u64，值是后面 JSON 头的字节长度。';
  if (node.key === 'header_json') return 'JSON 头。张量描述和 __metadata__ 都在这里，权重字节在头结束之后。';
  if (node.key === '__metadata__') return '可选元数据，键和值都是字符串。它在 JSON 头里，不是张量，没有数据偏移。';
  if (parent?.key === '__metadata__') return '一条元数据。只存在于 JSON 头中，不对应后面的权重字节。';
  if (node.key === 'dtype' && isTensorNode(parent)) return '元素类型，例如 F32、I8。它决定每个元素占多少字节。';
  if (node.key === 'shape' && isTensorNode(parent)) return '各维长度。元素个数等于各维相乘。';
  if (parent?.key === 'shape') return 'shape 的一维长度。';
  if (node.key === 'data_offsets' && isTensorNode(parent)) return '两个相对偏移 [起始, 结束)。相对的是 JSON 头之后的数据区，结束位置不包含在内。';
  if (parent?.key === 'data_offsets' && node.key === '[0]') return '权重的起始偏移，相对数据区。绝对位置 = 数据区起点 + 该值。右键可跳转。';
  if (parent?.key === 'data_offsets' && node.key === '[1]') return '权重的结束偏移，相对数据区，不包含这个位置。字节数 = 结束 - 起始。';
  if (isTensorNode(node)) return '张量。dtype 和 shape 描述元素，data_offsets 指向头后面的权重字节。';
  if (!parent) return '当前文件。header_len 是头长度，header_json 是 JSON 头，其余是张量数据。';
  return 'JSON 头里的字段。';
}

function appendJson(node: JsonNode, depth: number, path: string, parent: JsonNode | null): void {
  const query = filterInput.value.trim().toLowerCase();
  if (query && !subtreeMatch(node, query)) return;
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const childHit = !!query && children.some((child) => !!child && subtreeMatch(child, query));
  const open = jsonExpanded.has(path) || childHit;
  flatJson.push({ node, depth, path, hasChildren, open, help: fieldHelp(node, parent) });
  if (!open) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child) appendJson(child, depth + 1, path + '/' + i, node);
  }
}

function rebuildJsonFlat(): void {
  flatJson = [];
  if (treeRoot) appendJson(treeRoot, 0, '', null);
  jsonList.setCount(flatJson.length);
}

function hideHint(): void {
  hintPop.classList.add('off');
}

function showHint(anchor: HTMLElement, text: string): void {
  hintPop.textContent = text;
  hintPop.classList.remove('off');
  const rect = anchor.getBoundingClientRect();
  const width = hintPop.offsetWidth;
  const height = hintPop.offsetHeight;
  hintPop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
  hintPop.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)) + 'px';
}

function renderJsonTree(): void {
  hideHint();
  const frag = document.createDocumentFragment();
  if (!flatJson.length) {
    if (info) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '无匹配';
      frag.appendChild(empty);
    }
  } else {
    const start = Math.floor(jsonList.scroll);
    const count = jsonList.visible();
    for (let i = 0; i < count; i++) {
      const row = flatJson[start + i];
      if (!row) break;
      frag.appendChild(jsonRow(row));
    }
  }
  jView.replaceChildren(frag);
}

function jsonRow(row: FlatJson): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'j-row' + (row.path === selectedJsonPath ? ' on' : '');
  wrap.style.paddingLeft = (4 + row.depth * 14) + 'px';
  const twist = document.createElement('button');
  twist.type = 'button';
  twist.className = 'twisty';
  twist.textContent = row.hasChildren ? (row.open ? '▼' : '▶') : '';
  twist.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!row.hasChildren) return;
    if (jsonExpanded.has(row.path)) jsonExpanded.delete(row.path);
    else jsonExpanded.add(row.path);
    rebuildJsonFlat();
  });
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'j-main';
  const key = document.createElement('span');
  key.className = 'j-key';
  key.textContent = row.node.key;
  const value = document.createElement('span');
  value.className = 'j-val';
  const suffix = shownValue(row.node);
  value.textContent = suffix;
  const tensor = info?.tensors.find((item) => item.name === row.node.key);
  if (tensor && tensor.flags.length) {
    wrap.classList.add('warn');
    main.title = tensor.flags.map((flag) => FLAG_TEXT[flag] || flag).join(', ');
  }
  main.append(key, value);
  wrap.addEventListener('click', () => selectRange(row.node.start, row.node.end, row.node.key, { jsonPath: row.path }));
  wrap.addEventListener('contextmenu', (event) => {
    if (row.node.target == null) return;
    event.preventDefault();
    openJumpMenu(event.clientX, event.clientY, row.node.base ?? 0, row.node.offset ?? 0, row.path, row.node.key);
  });
  wrap.append(twist, main);
  if (showFieldHelp && row.help) {
    const hint = document.createElement('button');
    hint.type = 'button';
    hint.className = 'hint';
    hint.addEventListener('click', (event) => event.stopPropagation());
    hint.addEventListener('mouseenter', () => showHint(hint, row.help));
    hint.addEventListener('mouseleave', hideHint);
    wrap.append(hint);
  }
  return wrap;
}

function selectRange(start: number, end: number, label: string, opt: { scrollList?: boolean; jsonPath?: string } = {}): void {
  if (!info || fileSize <= 0) return;
  let rangeStart = Math.max(0, Math.min(start, fileSize));
  let rangeEnd = Math.max(0, Math.min(end, fileSize));
  if (rangeEnd < rangeStart) rangeEnd = rangeStart;
  selection = { start: rangeStart, end: rangeEnd, label };
  cursor = Math.min(rangeStart, fileSize - 1);
  anchor = cursor;
  selectedJsonPath = opt.jsonPath ?? '';
  selectedName = '';
  if (!opt.jsonPath) {
    for (const tensor of info.tensors) {
      if (tensor.name === label) {
        selectedName = tensor.name;
        break;
      }
    }
  }
  const row = Math.floor(cursor / 16);
  const moved = hexList.scrollTo(row - Math.floor(hexList.visible() * 0.25));
  if (!moved) refreshHex();
  updateMark();
  if (opt.scrollList) {
    const index = flatJson.findIndex((item) => item.node.key === label);
    if (index >= 0) jsonList.scrollToIndex(index);
  }
  renderJsonTree();
  scheduleInspector();
}

function setCursor(offset: number, extend: boolean): void {
  if (!info || fileSize <= 0) return;
  offset = Math.max(0, Math.min(fileSize - 1, offset));
  if (!extend) anchor = offset;
  const start = Math.min(anchor, offset);
  const end = Math.max(anchor, offset) + 1;
  selection = { start, end, label: extend ? selection.label : '' };
  cursor = offset;
  const tensor = findTensor(offset);
  const nextName = tensor ? tensor.name : '';
  const nameChanged = nextName !== selectedName;
  selectedName = nextName;
  ensureVisible(offset);
  if (nameChanged) renderJsonTree();
  scheduleInspector();
}

function moveCursor(key: string, ctrl: boolean, shift: boolean): void {
  if (!info || fileSize <= 0) return;
  let next = cursor;
  const page = Math.max(1, hexList.visible()) * 16;
  if (key === 'ArrowLeft') next -= 1;
  else if (key === 'ArrowRight') next += 1;
  else if (key === 'ArrowUp') next -= 16;
  else if (key === 'ArrowDown') next += 16;
  else if (key === 'PageUp') next -= page;
  else if (key === 'PageDown') next += page;
  else if (key === 'Home') next = ctrl ? 0 : Math.floor(cursor / 16) * 16;
  else if (key === 'End') next = ctrl ? fileSize - 1 : Math.min(fileSize - 1, Math.floor(cursor / 16) * 16 + 15);
  setCursor(next, shift);
}

function hitOffset(e: Event): number | null {
  const fromTarget = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-off]') : null;
  let el = fromTarget;
  if (!el && 'clientX' in e && 'clientY' in e) {
    const pointer = e as MouseEvent;
    const under = document.elementFromPoint(pointer.clientX, pointer.clientY);
    el = under ? under.closest<HTMLElement>('[data-off]') : null;
  }
  if (!el) return null;
  const value = Number(el.dataset.off);
  return Number.isFinite(value) ? value : null;
}

function scheduleInspector() {
  if (inspScheduled) return;
  inspScheduled = true;
  requestAnimationFrame(() => {
    inspScheduled = false;
    updateInspector();
  });
}

function fmtChipInt(value: number | bigint): string {
  if (chipRadix === 10) return value.toString();
  const negative = typeof value === 'bigint' ? value < 0n : value < 0;
  const body = typeof value === 'bigint'
    ? (negative ? -value : value).toString(16)
    : Math.abs(value).toString(16);
  return (negative ? '-' : '') + '0x' + body.toUpperCase();
}

function fmtDecoded(value: number | bigint | null, unit: string): string {
  if (value == null) return '?';
  if (unit.startsWith('F') || unit === 'BF16') return fmtFloat(value as number);
  return fmtChipInt(value as number | bigint);
}

async function updateInspector() {
  const gen = ++inspGen;
  const myFile = fileGen;
  insVals.textContent = '';
  if (!info || fileSize <= 0) {
    insLoc.textContent = '未打开文件。大文件只读取当前可见字节。';
    insSel.textContent = '';
    insAddr.textContent = '';
    return;
  }
  const tensor = findTensor(cursor);
  const parts = [fmtOff(cursor) + ' (' + cursor.toLocaleString() + ')'];
  if (cursor < 8) parts.push('<header_len>');
  else if (cursor < info.dataStart) parts.push('<header_json>');
  else if (tensor) {
    parts.push(tensor.name);
    parts.push(tensor.dtype + ' [' + shapeStr(tensor.shape, 60) + ']');
    if (tensor.itemSize) {
      const index = Math.floor((cursor - tensor.start) / tensor.itemSize);
      const aligned = tensor.start + index * tensor.itemSize === cursor;
      parts.push('元素 #' + index + (aligned ? '' : ' 未对齐'));
    }
    parts.push('区间 ' + fmtOff(tensor.start) + '–' + fmtOff(tensor.end));
    parts.push('相对 ' + fmtOff(tensor.relStart) + '–' + fmtOff(tensor.relEnd));
    if (tensor.flags.length) parts.push(tensor.flags.map((flag: string) => FLAG_TEXT[flag] || flag).join(' '));
  } else parts.push('填充/间隙');
  if (selectedName && (!tensor || tensor.name !== selectedName)) parts.push('选中 ' + selectedName);
  insLoc.textContent = parts.join('   ');
  const span = selection.end - selection.start;
  insSel.textContent = span > 0 ? '选区 ' + span : '';

  insAddr.textContent = fmtOff(cursor);
  const size = DTYPE_SIZE[chipUnit] || 1;
  const count = Math.min(16, Math.floor((fileSize - cursor) / size));
  if (count <= 0) return;
  let buf: Uint8Array<ArrayBufferLike>;
  try {
    buf = await readCached(cursor, size * count);
  } catch (err) {
    if (gen === inspGen) insVals.textContent = '读取失败';
    return;
  }
  if (gen !== inspGen || myFile !== fileGen) return;
  const values = decodeList(buf, chipUnit, size, count);
  insVals.textContent = values.map((value) => fmtDecoded(value, chipUnit)).join('  ');
}

function parseOffset(text: string): number | null {
  const source = text.trim().replace(/_/g, '');
  if (!source) return null;
  try {
    let value: bigint | null = null;
    if (/^0x[0-9a-f]+$/i.test(source)) value = BigInt(source);
    else if (/^[0-9]+$/.test(source)) value = BigInt(source);
    else if (/^[0-9a-f]+$/i.test(source)) value = BigInt('0x' + source);
    if (value == null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  } catch (err) {
    return null;
  }
}

function findNodePath(node: JsonNode, name: string, path: string): string | null {
  if (path && node.type === 'object' && node.key === name) return path;
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    const found = findNodePath(child, name, path + '/' + i);
    if (found) return found;
  }
  return null;
}

function expandTo(path: string): void {
  jsonExpanded.add('');
  const bits = path.split('/').filter((part) => part.length > 0);
  let acc = '';
  for (let i = 0; i < bits.length - 1; i++) {
    acc += '/' + bits[i];
    jsonExpanded.add(acc);
  }
}

function indexOfBytes(hay: Uint8Array<ArrayBufferLike>, needle: Uint8Array): number {
  if (!needle.length || hay.length < needle.length) return -1;
  const last = hay.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let same = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        same = false;
        break;
      }
    }
    if (same) return i;
  }
  return -1;
}

function parseNeedle(text: string): Uint8Array | null {
  const raw = text.trim();
  if (!raw) return null;
  if (/^0x[0-9a-f]+$/i.test(raw)) {
    const hex = raw.slice(2);
    if (hex.length % 2) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (/^[0-9a-f]{1,2}(\s+[0-9a-f]{1,2})+$/i.test(raw)) {
    const parts = raw.split(/\s+/);
    const out = new Uint8Array(parts.length);
    for (let i = 0; i < parts.length; i++) out[i] = Number.parseInt(parts[i] ?? '', 16);
    return out;
  }
  return new TextEncoder().encode(raw);
}

async function scanRange(needle: Uint8Array, from: number, until: number, gen: number): Promise<number> {
  const chunk = 1024 * 1024;
  const overlap = Math.max(0, needle.length - 1);
  let prev: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let pos = from;
  while (pos < until) {
    if (gen !== fileGen) return -1;
    const len = Math.min(chunk, until - pos);
    const res = await window.api.read(pos, len);
    if (gen !== fileGen) return -1;
    const buf = toU8(res.bytes);
    const combo = new Uint8Array(prev.length + buf.length);
    combo.set(prev, 0);
    combo.set(buf, prev.length);
    const at = indexOfBytes(combo, needle);
    if (at >= 0) return pos - prev.length + at;
    prev = overlap ? buf.subarray(Math.max(0, buf.length - overlap)) : new Uint8Array();
    pos += len;
  }
  return -1;
}

let binBusy = false;

async function searchBinary(): Promise<void> {
  if (!info || binBusy || fileSize <= 0) return;
  const needle = parseNeedle(binInput.value);
  if (!needle || !needle.length) return;
  binBusy = true;
  const gen = fileGen;
  const from = Math.max(0, Math.min(binFrom, fileSize));
  try {
    let hit = await scanRange(needle, from, fileSize, gen);
    if (hit < 0 && from > 0) hit = await scanRange(needle, 0, from, gen);
    if (gen !== fileGen) return;
    if (hit < 0) {
      binInput.classList.add('bad');
      return;
    }
    binInput.classList.remove('bad');
    binFrom = hit + Math.max(1, needle.length);
    selectRange(hit, Math.min(fileSize, hit + needle.length), '搜索');
  } finally {
    binBusy = false;
  }
}

function setPath(text: string, title = text): void {
  pathEl.textContent = text;
  pathEl.title = title;
}

function jumpToInput() {
  if (!info) return;
  const offset = parseOffset(gotoInput.value);
  if (offset == null) {
    gotoInput.classList.add('bad');
    return;
  }
  gotoInput.classList.remove('bad');
  setCursor(Math.max(0, Math.min(offset, fileSize - 1)), false);
}

function applyInfo(next: FileInfo): void {
  fileGen++;
  info = next;
  fileSize = next.fileSize;
  cache = null;
  cache2 = null;
  inflight.clear();
  lastPaint = null;
  cursor = 0;
  anchor = 0;
  selection = { start: 0, end: 0, label: '' };
  selectedName = '';
  selectedJsonPath = '';
  jsonExpanded.clear();
  jsonExpanded.add('');
  jsonExpanded.add('/1');
  filterInput.value = '';
  binInput.value = '';
  binFrom = 0;
  binInput.classList.remove('bad');
  applyAddrWidth();
  const base = next.filePath.split(/[/\\]/).pop() ?? next.filePath;
  document.title = 'DeModel — ' + base;
  setPath(next.filePath + '  ·  ' + fmtSize(next.fileSize), next.filePath);
  renderStructure();
  hexList.scroll = 0;
  jsonList.scroll = 0;
  rebuildJsonFlat();
  hexList.setCount(Math.ceil(fileSize / 16));
  selectRange(0, Math.min(8, fileSize), 'header_len');
}

function isFileInfo(value: OpenResponse): value is FileInfo {
  return !!value && !('error' in value);
}

async function loadPath(filePath: string): Promise<void> {
  const token = ++loadToken;
  setPath('正在解析… ' + filePath, filePath);
  let res: OpenResponse;
  try {
    res = await window.api.openPath(filePath);
  } catch (err) {
    if (token !== loadToken) return;
    setPath(errText(err));
    return;
  }
  if (token !== loadToken) return;
  if (!isFileInfo(res)) {
    if (res && 'error' in res) setPath(res.error);
    return;
  }
  applyInfo(res);
}

async function doOpen(): Promise<void> {
  let res: OpenResponse;
  try {
    res = await window.api.openFile();
  } catch (err) {
    setPath(errText(err));
    return;
  }
  if (!res) return;
  const token = ++loadToken;
  if (!isFileInfo(res)) {
    if (token === loadToken && 'error' in res) setPath(res.error);
    return;
  }
  if (token === loadToken) applyInfo(res);
}

function buildHexHead() {
  const addr = document.createElement('span');
  addr.className = 'addr';
  addr.textContent = 'Offset';
  const hexs = document.createElement('span');
  hexs.className = 'hexs';
  for (let i = 0; i < 16; i++) {
    const cell = document.createElement('span');
    cell.className = 'b';
    cell.textContent = HEX[i];
    hexs.appendChild(cell);
  }
  const ascii = document.createElement('span');
  ascii.className = 'asciis';
  ascii.textContent = 'ASCII';
  hexHead.replaceChildren(addr, hexs, ascii);
  hexHead.className = 'row head';
}

buildHexHead();

let recentFiles: string[] = [];
let openMenuKind: 'file' | 'edit' | 'view' | '' = '';

function fileTitle(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const parent = filePath.split(/[/\\]/).slice(-2, -1)[0];
  const duplicated = recentFiles.filter((item) => (item.split(/[/\\]/).pop() || item) === name).length > 1;
  return duplicated && parent ? name + ' (' + parent + ')' : name;
}

function hideCtx(): void {
  ctxMenu.classList.add('off');
  ctxMenu.replaceChildren();
}

function hideSub(): void {
  appSub.classList.add('off');
  appSub.replaceChildren();
}

function hideAppMenu(): void {
  openMenuKind = '';
  hideSub();
  appMenu.classList.add('off');
  menuFile.classList.remove('open');
  menuEdit.classList.remove('open');
  menuView.classList.remove('open');
}

function showRadixSub(anchor: HTMLElement): void {
  const items = [
    { label: '十六进制', on: radix === 16, run: () => setRadix(16) },
    { label: '十进制', on: radix === 10, run: () => setRadix(10) },
  ];
  appSub.replaceChildren();
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mi' + (item.on ? ' on' : '');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.label;
    const mark = document.createElement('span');
    mark.className = 'mark';
    button.append(label, mark);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      hideAppMenu();
      item.run();
    });
    appSub.appendChild(button);
  }
  appSub.classList.remove('off');
  const rect = anchor.getBoundingClientRect();
  const width = appSub.offsetWidth;
  const left = rect.right + width > window.innerWidth - 8 ? rect.left - width : rect.right - 1;
  appSub.style.left = Math.max(8, left) + 'px';
  appSub.style.top = rect.top + 'px';
}

function openCtx(x: number, y: number, label: string, action: () => void): void {
  hideAppMenu();
  ctxMenu.replaceChildren();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mi';
  const text = document.createElement('span');
  text.className = 'label';
  text.textContent = label;
  button.append(text);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    hideCtx();
    action();
  });
  ctxMenu.appendChild(button);
  ctxMenu.classList.remove('off');
  const width = ctxMenu.offsetWidth;
  const height = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + 'px';
  ctxMenu.style.top = Math.max(8, Math.min(y, window.innerHeight - height - 8)) + 'px';
}

function openJumpMenu(x: number, y: number, base: number, offset: number, jsonPath: string, label: string): void {
  openCtx(x, y, '跳转到：' + fmtInt(base) + ' + ' + fmtInt(offset), () => {
    selectRange(base + offset, base + offset + 1, label, { jsonPath });
  });
}

function locateField(): void {
  const path = fieldForSelection();
  if (!path) return;
  expandTo(path);
  selectedJsonPath = path;
  rebuildJsonFlat();
  const index = flatJson.findIndex((row) => row.path === path);
  if (index >= 0) jsonList.scrollToIndex(index);
  renderJsonTree();
}

function setRadix(next: 10 | 16): void {
  radix = next;
  applyAddrWidth();
  renderJsonTree();
  refreshHex();
  scheduleInspector();
}

function showAppMenu(kind: 'file' | 'edit' | 'view'): void {
  hideSub();
  const rows: Array<{ label: string; key: string; title?: string; on?: boolean; sub?: boolean; run: () => void } | 'sep'> = kind === 'view'
    ? [
      { label: '单位格式', key: '›', sub: true, run: () => {} },
      { label: '字段说明', key: '', on: showFieldHelp, run: () => { showFieldHelp = !showFieldHelp; renderJsonTree(); } },
    ]
    : kind === 'edit'
    ? [
      { label: '撤销', key: 'Ctrl+Z', run: () => { void window.api.editCommand('undo'); } },
      { label: '重做', key: 'Ctrl+Y', run: () => { void window.api.editCommand('redo'); } },
      'sep',
      { label: '剪切', key: 'Ctrl+X', run: () => { void window.api.editCommand('cut'); } },
      { label: '复制', key: 'Ctrl+C', run: () => { void window.api.editCommand('copy'); } },
      { label: '粘贴', key: 'Ctrl+V', run: () => { void window.api.editCommand('paste'); } },
      { label: '全选', key: 'Ctrl+A', run: () => { void window.api.editCommand('selectAll'); } },
    ]
    : [
      { label: '打开', key: 'Ctrl+O', run: () => { void doOpen(); } },
      ...(recentFiles.length ? ['sep' as const] : []),
      ...recentFiles.map((filePath) => ({
        label: fileTitle(filePath),
        key: '',
        title: filePath,
        run: () => { void loadPath(filePath); },
      })),
      'sep',
      { label: '退出', key: '', run: () => { void window.api.quit(); } },
    ];
  appMenu.replaceChildren();
  for (const row of rows) {
    if (row === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'sep';
      appMenu.appendChild(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mi' + (row.on ? ' on' : '');
    if (row.title) button.title = row.title;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = row.label;
    button.append(label);
    if (row.key) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = row.key;
      button.append(key);
    }
    if (typeof row.on === 'boolean') {
      const mark = document.createElement('span');
      mark.className = 'mark';
      button.append(mark);
    }
    button.addEventListener('pointerenter', () => {
      if (row.sub) showRadixSub(button);
      else hideSub();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (row.sub) {
        showRadixSub(button);
        return;
      }
      hideAppMenu();
      row.run();
    });
    appMenu.appendChild(button);
  }
  const anchor = kind === 'file' ? menuFile : kind === 'edit' ? menuEdit : menuView;
  const rect = anchor.getBoundingClientRect();
  appMenu.style.left = rect.left + 'px';
  appMenu.style.top = rect.bottom + 'px';
  appMenu.classList.remove('off');
  openMenuKind = kind;
  menuFile.classList.toggle('open', kind === 'file');
  menuEdit.classList.toggle('open', kind === 'edit');
  menuView.classList.toggle('open', kind === 'view');
}

function toggleAppMenu(kind: 'file' | 'edit' | 'view'): void {
  if (openMenuKind === kind) hideAppMenu();
  else showAppMenu(kind);
}

menuFile.addEventListener('click', () => { hideCtx(); toggleAppMenu('file'); });
menuEdit.addEventListener('click', () => { hideCtx(); toggleAppMenu('edit'); });
menuView.addEventListener('click', () => { hideCtx(); toggleAppMenu('view'); });
menuFile.addEventListener('pointerenter', () => { if (openMenuKind) showAppMenu('file'); });
menuEdit.addEventListener('pointerenter', () => { if (openMenuKind) showAppMenu('edit'); });
menuView.addEventListener('pointerenter', () => { if (openMenuKind) showAppMenu('view'); });
chipRadixBox.addEventListener('click', (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest('button') : null;
  if (!button) return;
  const next = Number(button.dataset.radix);
  if (next !== 10 && next !== 16) return;
  chipRadix = next;
  chipRadixBox.querySelectorAll('button').forEach((item) => item.classList.toggle('on', Number(item.dataset.radix) === chipRadix));
  scheduleInspector();
});
chipUnitBox.addEventListener('click', (event) => {
  const button = event.target instanceof HTMLElement ? event.target.closest('button') : null;
  const unit = button?.dataset.unit;
  if (!unit || !DTYPE_SIZE[unit]) return;
  chipUnit = unit;
  chipUnitBox.querySelectorAll('button').forEach((item) => item.classList.toggle('on', item.dataset.unit === chipUnit));
  scheduleInspector();
});
window.api.onRecent((files) => { recentFiles = files; });
window.api.recent().then((files) => { recentFiles = files; }).catch(() => {});
function fieldForSelection(): string | null {
  if (!info || !treeRoot || fileSize <= 0 || selection.end <= selection.start) return null;
  const start = selection.start;
  const end = selection.end;
  let bestPath = '';
  let bestSpan = Number.POSITIVE_INFINITY;
  const visit = (node: JsonNode, path: string): void => {
    if (node.start <= start && node.end >= end) {
      const span = node.end - node.start;
      if (span < bestSpan) {
        bestSpan = span;
        bestPath = path;
      }
    }
    const children = node.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child) visit(child, path + '/' + i);
    }
  };
  visit(treeRoot, '');
  if (bestPath) return bestPath;
  const tensor = info.tensors.find((item) => item.start <= start && item.end >= end) ?? findTensor(start);
  if (!tensor) return null;
  return findNodePath(treeRoot, tensor.name, '');
}

gotoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    jumpToInput();
  }
});
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(rebuildJsonFlat, 60);
});
binInput.addEventListener('input', () => {
  binFrom = 0;
  binInput.classList.remove('bad');
});
binInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  void searchBinary();
});

split.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = side.getBoundingClientRect().width;
  split.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
    const max = Math.max(360, window.innerWidth * 0.75);
    side.style.width = Math.max(280, Math.min(max, startW + ev.clientX - startX)) + 'px';
  };
  const up = () => {
    split.removeEventListener('pointermove', move);
    split.removeEventListener('pointerup', up);
  };
  split.addEventListener('pointermove', move);
  split.addEventListener('pointerup', up);
});

hexView.addEventListener('contextmenu', (event) => {
  const offset = hitOffset(event);
  if (offset != null && (offset < selection.start || offset >= selection.end)) setCursor(offset, false);
  if (!fieldForSelection()) return;
  event.preventDefault();
  openCtx(event.clientX, event.clientY, '定位字段', locateField);
});
hexView.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const offset = hitOffset(e);
  if (offset == null) return;
  dragOn = true;
  hexView.setPointerCapture(e.pointerId);
  setCursor(offset, e.shiftKey);
});
hexView.addEventListener('pointermove', (e) => {
  if (!dragOn) return;
  const offset = hitOffset(e);
  if (offset == null) return;
  setCursor(offset, true);
});
hexView.addEventListener('pointerup', () => { dragOn = false; });
hexView.addEventListener('pointercancel', () => { dragOn = false; });
hexView.addEventListener('dblclick', (e) => {
  const offset = hitOffset(e);
  if (offset == null || !info) return;
  const tensor = findTensor(offset);
  if (!tensor || !tensor.itemSize) return;
  const index = Math.floor((offset - tensor.start) / tensor.itemSize);
  const start = tensor.start + index * tensor.itemSize;
  anchor = start;
  cursor = Math.max(0, Math.min(start, fileSize - 1));
  selection = { start, end: Math.min(tensor.end, start + tensor.itemSize), label: tensor.name };
  selectedName = tensor.name;
  refreshHex();
  renderJsonTree();
  scheduleInspector();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideAppMenu();
    hideCtx();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    hideAppMenu();
    void doOpen();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    gotoInput.focus();
    gotoInput.select();
    return;
  }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    filterInput.focus();
    return;
  }
  if (!info) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    moveCursor(e.key, e.ctrlKey, e.shiftKey);
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!(event.target instanceof Node)) return;
  if (ctxMenu.contains(event.target)) return;
  hideCtx();
  if (appMenu.contains(event.target) || appSub.contains(event.target) || menuFile.contains(event.target) || menuEdit.contains(event.target) || menuView.contains(event.target)) return;
  hideAppMenu();
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag');
});
document.addEventListener('dragleave', () => document.body.classList.remove('drag'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const filePath = window.api.getPathForFile(file);
  if (filePath) loadPath(filePath);
});

const resizeObserver = new ResizeObserver(() => {
  hexList.updateThumb();
  scheduleHexPaint();
  jsonList.updateThumb();
  renderJsonTree();
});
resizeObserver.observe(hexView);
resizeObserver.observe(jView);

window.api.initialFile().then((filePath) => {
  if (filePath) loadPath(filePath);
}).catch(() => {});
