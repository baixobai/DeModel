import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import path from 'path';
import { parseFile, type ParsedFile } from './parse';

let win: BrowserWindow | null = null;
let session: ParsedFile | null = null;
let openSerial = 0;
let recentFiles: string[] = [];

function recentStore(): string {
  return path.join(app.getPath('userData'), 'recent.json');
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

function loadRecent(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(recentStore(), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return;
    recentFiles = raw.filter((item): item is string => typeof item === 'string').slice(0, 10);
  } catch {
    recentFiles = [];
  }
}

function remember(filePath: string): void {
  recentFiles = [filePath, ...recentFiles.filter((item) => !samePath(item, filePath))].slice(0, 10);
  try {
    fs.mkdirSync(path.dirname(recentStore()), { recursive: true });
    fs.writeFileSync(recentStore(), JSON.stringify(recentFiles));
  } catch {
    // History is optional when the store cannot be written.
  }
  win?.webContents.send('recent-changed', recentFiles);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function closeSession(): Promise<void> {
  if (!session) return;
  const current = session;
  session = null;
  await current.fh.close().catch(() => {});
}

async function openPath(filePath: string): Promise<FileInfo | OpenError> {
  if (!filePath) return { error: '路径无效' };
  const serial = ++openSerial;
  try {
    const parsed = await parseFile(filePath);
    if (serial !== openSerial) {
      await parsed.fh.close().catch(() => {});
      return { error: '已打开其他文件' };
    }
    const prev = session;
    session = parsed;
    if (prev) await prev.fh.close().catch(() => {});
    remember(session.info.filePath);
    return session.info;
  } catch (err) {
    return { error: '打开失败: ' + errText(err) };
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#16181d',
    title: 'DeModel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('open-file', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    title: '打开 Safetensors',
    properties: ['openFile'],
    filters: [
      { name: 'Safetensors', extensions: ['safetensors'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return openPath(result.filePaths[0]);
});

ipcMain.handle('open-path', (_event, filePath: unknown) => {
  if (typeof filePath !== 'string') return { error: '路径无效' };
  return openPath(filePath);
});

ipcMain.handle('recent-list', () => recentFiles);

ipcMain.handle('edit-command', (event, command: unknown) => {
  const contents = event.sender;
  if (command === 'undo') contents.undo();
  else if (command === 'redo') contents.redo();
  else if (command === 'cut') contents.cut();
  else if (command === 'copy') contents.copy();
  else if (command === 'paste') contents.paste();
  else if (command === 'selectAll') contents.selectAll();
});

ipcMain.handle('quit', () => {
  app.quit();
});

ipcMain.handle('initial-file', () => {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const fromArgv = args.find((arg) => !arg.startsWith('-') && /\.safetensors$/i.test(arg)) || null;
  return fromArgv ?? session?.info.filePath ?? null;
});

ipcMain.handle('read', async (_event, offset: unknown, length: unknown) => {
  if (!session) throw new Error('未打开文件');
  if (typeof offset !== 'number' || typeof length !== 'number' || !Number.isFinite(offset) || !Number.isFinite(length)) {
    throw new Error('偏移无效');
  }
  let position = Math.trunc(offset);
  let size = Math.trunc(length);
  const fileSize = session.info.fileSize;
  if (position < 0) position = 0;
  if (position > fileSize) position = fileSize;
  size = Math.max(0, Math.min(size, 1024 * 1024, fileSize - position));
  const buf = Buffer.alloc(size);
  const { bytesRead } = await session.fh.read(buf, 0, size, position);
  return { offset: position, bytes: bytesRead === size ? buf : Buffer.from(buf.subarray(0, bytesRead)) };
});

function fileHash(filePath: string): string {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function enableDevReload(): void {
  if (app.isPackaged) return;
  const dist = __dirname;
  const srcDir = path.join(__dirname, '..', 'src');
  const hashes = new Map<string, string>();
  const remember = (filePath: string): void => {
    hashes.set(filePath, fileHash(filePath));
  };
  for (const name of ['main.js', 'preload.js', 'renderer.js', 'index.html', 'style.css']) {
    remember(path.join(dist, name));
  }
  for (const name of ['index.html', 'style.css']) remember(path.join(srcDir, name));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let restart = false;
  let relaunching = false;
  const flush = (): void => {
    timer = null;
    if (relaunching) return;
    if (restart) {
      relaunching = true;
      spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'inherit' }).unref();
      app.exit(0);
      return;
    }
    win?.webContents.reloadIgnoringCache();
  };
  const touch = (filePath: string, kind: 'restart' | 'reload'): void => {
    const next = fileHash(filePath);
    if (!next || next === hashes.get(filePath)) return;
    hashes.set(filePath, next);
    if (kind === 'restart') restart = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
  };

  fs.watch(dist, (_event, filename) => {
    if (!filename || filename.endsWith('.map')) return;
    const filePath = path.join(dist, filename);
    if (filename === 'main.js' || filename === 'preload.js') touch(filePath, 'restart');
    else if (filename === 'renderer.js' || filename === 'index.html' || filename === 'style.css') touch(filePath, 'reload');
  });
  fs.watch(srcDir, (_event, filename) => {
    if (filename !== 'index.html' && filename !== 'style.css') return;
    const from = path.join(srcDir, filename);
    const next = fileHash(from);
    if (!next || next === hashes.get(from)) return;
    hashes.set(from, next);
    fs.copyFileSync(from, path.join(dist, filename));
  });
}

app.whenReady().then(() => {
  loadRecent();
  Menu.setApplicationMenu(null);
  enableDevReload();
  createWindow();
});

app.on('window-all-closed', () => {
  closeSession().finally(() => app.quit());
});
