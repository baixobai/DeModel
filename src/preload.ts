import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api: HostApi = {
  openFile: () => ipcRenderer.invoke('open-file'),
  openPath: (filePath: string) => ipcRenderer.invoke('open-path', filePath),
  read: (offset: number, length: number) => ipcRenderer.invoke('read', offset, length),
  initialFile: () => ipcRenderer.invoke('initial-file'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  recent: () => ipcRenderer.invoke('recent-list'),
  onRecent: (handler: (files: string[]) => void) => {
    ipcRenderer.on('recent-changed', (_event, files: string[]) => handler(files));
  },
  editCommand: (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => ipcRenderer.invoke('edit-command', command),
  quit: () => ipcRenderer.invoke('quit'),
};

contextBridge.exposeInMainWorld('api', api);
