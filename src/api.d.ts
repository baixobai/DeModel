interface TensorInfo {
  name: string;
  dtype: string;
  shape: number[];
  itemSize: number;
  start: number;
  end: number;
  bytes: number;
  relStart: number | null;
  relEnd: number | null;
  flags: string[];
}

interface JsonNode {
  key: string;
  type: 'object' | 'array' | 'string' | 'number' | 'bool' | 'null';
  start: number;
  end: number;
  text: string;
  children?: JsonNode[];
  target?: number;
  base?: number;
  offset?: number;
}

interface FileInfo {
  filePath: string;
  fileSize: number;
  headerSize: number;
  dataStart: number;
  trailing: number;
  metadata: Record<string, string> | null;
  headerTree: JsonNode;
  tensors: TensorInfo[];
  warnCount: number;
}

interface ReadResult {
  offset: number;
  bytes: Uint8Array;
}

interface OpenError {
  error: string;
}

type OpenResponse = FileInfo | OpenError | null;

interface HostApi {
  openFile(): Promise<OpenResponse>;
  openPath(filePath: string): Promise<OpenResponse>;
  read(offset: number, length: number): Promise<ReadResult>;
  initialFile(): Promise<string | null>;
  getPathForFile(file: File): string;
  recent(): Promise<string[]>;
  onRecent(handler: (files: string[]) => void): void;
  editCommand(command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<void>;
  quit(): Promise<void>;
}

interface Window {
  api: HostApi;
}
