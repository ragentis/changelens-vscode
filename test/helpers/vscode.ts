/**
 * A stand-in for the `vscode` module, aliased in by vitest.config.mts.
 *
 * The filesystem is real: `workspace.fs` runs against a temp directory, so size, mtime, encoding
 * and missing-file errors behave as they do in the editor. Only the parts of the API the model
 * touches are here; anything else should fail loudly rather than silently do nothing.
 */

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import type * as api from "vscode";

export class Uri {
  readonly fsPath: string;

  private constructor(
    readonly scheme: string,
    fsPath: string,
  ) {
    this.fsPath = nodePath.normalize(fsPath);
  }

  static file(fsPath: string): Uri {
    return new Uri("file", fsPath);
  }

  static parse(value: string): Uri {
    const [scheme = "file", rest = ""] = value.split("://");
    return new Uri(scheme, rest);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, nodePath.join(base.fsPath, ...segments));
  }

  get path(): string {
    return this.fsPath.split(nodePath.sep).join("/");
  }

  with(change: { scheme?: string; query?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, this.fsPath);
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  /** Both real overloads: two positions, or the four numbers that spell them out. */
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(
    start: Position | number,
    end: Position | number,
    endLine?: number,
    endCharacter?: number,
  ) {
    if (typeof start === "number" && typeof end === "number") {
      this.start = new Position(start, end);
      this.end = new Position(endLine ?? start, endCharacter ?? end);
    } else {
      this.start = start as Position;
      this.end = end as Position;
    }
  }
}

/** Collapsed selections are all the extension makes, so anchor and active follow the two ends. */
export class Selection extends Range {
  get anchor(): Position {
    return this.start;
  }

  get active(): Position {
    return this.end;
  }
}

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: { command: string; title: string; arguments?: unknown[] },
  ) {}
}

export const EndOfLine = { LF: 1, CRLF: 2 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class ThemeIcon {
  static readonly Folder = new ThemeIcon("folder");
  static readonly File = new ThemeIcon("file");

  constructor(readonly id: string) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(public value = "") {}

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }
}

export class TreeItem {
  label: string | undefined;
  resourceUri: Uri | undefined;
  description: string | undefined;
  tooltip: string | undefined;
  contextValue: string | undefined;
  iconPath: unknown;
  command: { command: string; title: string; arguments?: unknown[] } | undefined;

  constructor(
    labelOrUri: string | Uri,
    readonly collapsibleState: number = TreeItemCollapsibleState.None,
  ) {
    if (labelOrUri instanceof Uri) {
      this.resourceUri = labelOrUri;
    } else {
      this.label = labelOrUri;
    }
  }
}

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;
export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const;

export class StatusBarItem {
  text = "";
  tooltip: string | undefined;
  command: string | undefined;
  /** Whether `show` was the last of the two called, which is what the user actually sees. */
  visible = false;
  disposed = false;

  constructor(
    readonly alignment: number,
    readonly priority: number | undefined,
  ) {}

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class OutputChannel {
  readonly lines: string[] = [];
  shown = 0;
  disposed = false;

  constructor(readonly name: string) {}

  appendLine(line: string): void {
    this.lines.push(line);
  }

  show(): void {
    this.shown += 1;
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class TreeView<T> {
  /** Starts on screen; `setVisible` is how a test hides the panel. */
  visible = true;
  readonly revealed: { node: T; options: unknown }[] = [];
  disposed = false;
  private readonly visibility = new EventEmitter<{ visible: boolean }>();

  constructor(
    readonly viewId: string,
    readonly options: unknown,
  ) {}

  readonly onDidChangeVisibility = (listener: (event: { visible: boolean }) => unknown) =>
    this.visibility.event(listener);

  reveal(node: T, options?: unknown): Promise<void> {
    this.revealed.push({ node, options });
    return Promise.resolve();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.visibility.fire({ visible });
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A glob anchored to a folder. Only the pattern is inspected, which is how tests find a watcher. */
export class RelativePattern {
  constructor(
    readonly base: WorkspaceFolder | Uri,
    readonly pattern: string,
  ) {}
}

export class FileSystemWatcher {
  private readonly changed = new EventEmitter<Uri>();
  private readonly created = new EventEmitter<Uri>();
  private readonly deleted = new EventEmitter<Uri>();
  disposed = false;

  constructor(readonly glob: string | RelativePattern) {}

  readonly onDidChange = (listener: (uri: Uri) => unknown) => this.changed.event(listener);
  readonly onDidCreate = (listener: (uri: Uri) => unknown) => this.created.event(listener);
  readonly onDidDelete = (listener: (uri: Uri) => unknown) => this.deleted.event(listener);

  /** Raises the event the editor would raise for a path this watcher covers. */
  fire(kind: "change" | "create" | "delete", uri: Uri): void {
    ({ change: this.changed, create: this.created, delete: this.deleted })[kind].fire(uri);
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** An opaque handle in the real API; here it only has to be identifiable and disposable. */
export class TextEditorDecorationType {
  disposed = false;

  constructor(readonly options: Record<string, unknown>) {}

  dispose(): void {
    this.disposed = true;
  }
}

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;
export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export class FileSystemError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "FileSystemError";
  }

  static FileNotFound(): FileSystemError {
    return new FileSystemError("FileNotFound");
  }

  static NoPermissions(): FileSystemError {
    return new FileSystemError("NoPermissions");
  }

  static FileNotADirectory(): FileSystemError {
    return new FileSystemError("FileNotADirectory");
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();

  readonly event = (listener: (value: T) => unknown): { dispose: () => void } => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(value: T): void {
    // Snapshot first: a listener is allowed to dispose itself while being called.
    const current = Array.from(this.listeners);
    for (const listener of current) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  const pattern = /\r\n|\n|\r/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/** The extensions the editor's own language detection covers for the mirror languages. */
const LANGUAGE_IDS = new Map([
  [".ts", "typescript"],
  [".tsx", "typescriptreact"],
  [".js", "javascript"],
  [".jsx", "javascriptreact"],
  [".json", "json"],
  [".jsonc", "jsonc"],
  [".css", "css"],
  [".scss", "scss"],
  [".less", "less"],
  [".vue", "vue"],
  [".mdx", "mdx"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);

/** A document as the extension sees it: the buffer, not the bytes on disk. */
export class TextDocument {
  isClosed = false;
  isDirty = false;
  eol: number = EndOfLine.LF;
  /** Derived from the path, as the editor derives it, until something retags the document. */
  languageId: string;

  constructor(
    readonly uri: Uri,
    private text: string,
  ) {
    this.languageId = LANGUAGE_IDS.get(nodePath.extname(uri.fsPath).toLowerCase()) ?? "plaintext";
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  get lineCount(): number {
    return lineStarts(this.text).length;
  }

  lineAt(line: number): { text: string; range: Range } {
    const starts = lineStarts(this.text);
    const start = starts[line] ?? this.text.length;
    const nextStart = starts[line + 1];
    const raw =
      nextStart === undefined ? this.text.slice(start) : this.text.slice(start, nextStart);
    const content = raw.replace(/\r?\n$|\r$/, "");
    return {
      text: content,
      range: new Range(new Position(line, 0), new Position(line, content.length)),
    };
  }

  offsetAt(position: Position): number {
    const starts = lineStarts(this.text);
    const start = starts[position.line] ?? this.text.length;
    return Math.min(start + position.character, this.text.length);
  }
}

type EditOperation =
  | { kind: "replace"; uri: Uri; range: Range; text: string }
  | { kind: "create"; uri: Uri; contents: Uint8Array | undefined; overwrite: boolean }
  | { kind: "delete"; uri: Uri; ignoreIfNotExists: boolean };

export class WorkspaceEdit {
  readonly operations: EditOperation[] = [];

  replace(uri: Uri, range: Range, text: string): void {
    this.operations.push({ kind: "replace", uri, range, text });
  }

  createFile(
    uri: Uri,
    options?: { overwrite?: boolean | undefined; contents?: Uint8Array | undefined },
  ): void {
    this.operations.push({
      kind: "create",
      uri,
      contents: options?.contents,
      overwrite: options?.overwrite ?? false,
    });
  }

  deleteFile(uri: Uri, options?: { ignoreIfNotExists?: boolean | undefined }): void {
    this.operations.push({
      kind: "delete",
      uri,
      ignoreIfNotExists: options?.ignoreIfNotExists ?? false,
    });
  }
}

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
}

export interface DecorationOptions {
  range: Range;
  hoverMessage?: MarkdownString;
  renderOptions?: Record<string, unknown>;
}

/** Records what was set on it rather than drawing anything, so a test can read the last render. */
export class TextEditor {
  selection: Selection;
  readonly decorations = new Map<TextEditorDecorationType, (Range | DecorationOptions)[]>();
  /** What the editor was asked to scroll into view, in the order it was asked. */
  readonly revealed: Range[] = [];

  constructor(
    readonly document: TextDocument,
    line = 0,
  ) {
    this.selection = new Selection(line, 0, line, 0);
  }

  setDecorations(type: TextEditorDecorationType, items: (Range | DecorationOptions)[]): void {
    this.decorations.set(type, items);
  }

  revealRange(range: Range): void {
    this.revealed.push(range);
  }
}

export interface ShownMessage {
  kind: "information" | "warning" | "error";
  message: string;
  items: string[];
  /** The modal options' `detail`, which is where a dialog puts anything longer than one line. */
  detail: string | undefined;
}

export interface ConfigurationChangeEvent {
  affectsConfiguration: (section: string) => boolean;
}

export interface FileRename {
  oldUri: Uri;
  newUri: Uri;
}

/** A registered virtual file system, kept with its options so a test can assert them. */
export interface FileSystemProviderRegistration {
  provider: { readFile: (uri: api.Uri) => Uint8Array | Thenable<Uint8Array> };
  options: { isReadonly?: boolean; isCaseSensitive?: boolean } | undefined;
}

/** The workspace events the watcher subscribes to, each raised by a test through `state.events`. */
function workspaceEvents() {
  return {
    documentChanged: new EventEmitter<{ document: TextDocument }>(),
    documentOpened: new EventEmitter<TextDocument>(),
    documentSaved: new EventEmitter<TextDocument>(),
    documentClosed: new EventEmitter<TextDocument>(),
    filesCreated: new EventEmitter<{ files: readonly Uri[] }>(),
    filesDeleted: new EventEmitter<{ files: readonly Uri[] }>(),
    filesRenamed: new EventEmitter<{ files: readonly FileRename[] }>(),
    configurationChanged: new EventEmitter<ConfigurationChangeEvent>(),
    foldersChanged: new EventEmitter<void>(),
  };
}

/** Everything the fake editor knows. Tests drive the extension through this. */
export const state = {
  folders: [] as WorkspaceFolder[],
  /** User-scope settings, which is also where an unscoped seed in a test lands. */
  configuration: new Map<string, unknown>(),
  /** Workspace-scope settings, which outrank the user's own. */
  workspaceConfiguration: new Map<string, unknown>(),
  documents: [] as TextDocument[],
  fileSystemProviders: new Map<string, FileSystemProviderRegistration>(),
  commands: new Map<string, (...args: never[]) => unknown>(),
  /** Commands invoked through `executeCommand`, including the built-in ones. */
  executed: [] as { command: string; args: unknown[] }[],
  shown: [] as ShownMessage[],
  shownDocuments: [] as Uri[],
  activeTextEditor: undefined as TextEditor | undefined,
  /** Editors on screen, which decorations are drawn into. The active one is not implied. */
  visibleTextEditors: [] as TextEditor[],
  statusBarItems: [] as StatusBarItem[],
  visibleEditorsChanged: new EventEmitter<TextEditor[]>(),
  /** Every watcher created, disposed ones included, so a test can assert they were released. */
  watchers: [] as FileSystemWatcher[],
  events: workspaceEvents(),
  outputChannels: [] as OutputChannel[],
  treeViews: [] as TreeView<unknown>[],
  activeEditorChanged: new EventEmitter<TextEditor | undefined>(),
  globalState: new Map<string, unknown>(),
  /** Per-workspace state, which is where a toolbar toggle is remembered instead of in settings. */
  workspaceState: new Map<string, unknown>(),
  /** How the user answers a dialog. The default dismisses everything. */
  answer: (_message: string, _items: string[]): string | undefined => undefined,
};

export function reset(): void {
  state.folders = [];
  state.configuration = new Map();
  state.workspaceConfiguration = new Map();
  state.documents = [];
  state.fileSystemProviders = new Map();
  state.commands = new Map();
  state.executed = [];
  state.shown = [];
  state.shownDocuments = [];
  state.activeTextEditor = undefined;
  state.visibleTextEditors = [];
  state.statusBarItems = [];
  state.visibleEditorsChanged = new EventEmitter();
  state.watchers = [];
  state.events = workspaceEvents();
  state.outputChannels = [];
  state.treeViews = [];
  state.activeEditorChanged = new EventEmitter();
  state.globalState = new Map();
  state.workspaceState = new Map();
  state.answer = () => undefined;
}

/**
 * Puts the cursor on `line` of an open document, as the active editor would. The active editor is
 * always on screen too, and it has to be the same object: code that reaches an editor through the
 * visible list writes the selection the commands then read.
 */
export function setActiveEditor(doc: TextDocument | undefined, line = 0): TextEditor | undefined {
  if (!doc) {
    state.activeTextEditor = undefined;
    state.activeEditorChanged.fire(undefined);
    return undefined;
  }

  const shown = state.visibleTextEditors.find((editor) => editor.document === doc);
  const active = shown ?? new TextEditor(doc);
  active.selection = new Selection(line, 0, line, 0);
  if (!shown) {
    state.visibleTextEditors = [...state.visibleTextEditors, active];
  }
  state.activeTextEditor = active;
  state.activeEditorChanged.fire(active);
  return active;
}

/** Replaces what is on screen and raises the event the editor raises for it. */
export function setVisibleEditors(...docs: TextDocument[]): TextEditor[] {
  state.visibleTextEditors = docs.map((doc) => new TextEditor(doc));
  state.visibleEditorsChanged.fire(state.visibleTextEditors);
  return state.visibleTextEditors;
}

function memento(store: () => Map<string, unknown>): api.Memento {
  return {
    keys: () => [...store().keys()],
    get: (key: string, fallback?: unknown) => store().get(key) ?? fallback,
    update: (key: string, value: unknown) => {
      store().set(key, value);
      return Promise.resolve();
    },
  } as api.Memento;
}

/** The workspace-scoped half of `ExtensionContext.workspaceState`, usable on its own. */
export const workspaceState: api.Memento = memento(() => state.workspaceState);

/**
 * A workspace state whose writes land a turn late. A caller that reads the mode without waiting
 * for the previous write sees the stale one, which is what serialization has to prevent.
 */
export function deferredWorkspaceState(): api.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: (key: string, value: unknown) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          store.set(key, value);
          resolve();
        }, 0);
      }),
  } as api.Memento;
}

/** A workspace state that never stores anything, for exercising a rejected write. */
export function failingWorkspaceState(message: string): api.Memento {
  return {
    keys: () => [],
    get: (_key: string, fallback?: unknown) => fallback,
    update: () => Promise.reject(new Error(message)),
  } as api.Memento;
}

/**
 * The subset of `ExtensionContext` the extension uses. `storagePath` stands in for the per-window
 * storage the editor grants; leaving it out is how a window with nowhere to persist is spelled.
 */
export function createExtensionContext(storagePath?: string): api.ExtensionContext {
  const context = {
    subscriptions: [] as { dispose: () => unknown }[],
    globalState: memento(() => state.globalState),
    workspaceState,
    storageUri: storagePath === undefined ? undefined : Uri.file(storagePath),
  };
  return context as unknown as api.ExtensionContext;
}

export function setWorkspaceFolders(paths: string[]): void {
  state.folders = paths.map((fsPath, index) => ({
    uri: Uri.file(fsPath),
    name: nodePath.basename(fsPath),
    index,
  }));
}

/** Opens a document backed by `text`, which from here on shadows the file on disk. */
export function openDocument(
  fsPath: string,
  text: string,
  isDirty = false,
  scheme = "file",
): TextDocument {
  const doc = new TextDocument(Uri.file(fsPath).with({ scheme }), text);
  doc.isDirty = isDirty;
  state.documents.push(doc);
  return doc;
}

export function closeDocument(doc: TextDocument): void {
  doc.isClosed = true;
  state.documents = state.documents.filter((open) => open !== doc);
}

/**
 * The fakes implement only the slice of the API the extension uses, so the point where one is
 * handed to production code is asserted here, once, instead of at every call site in a test.
 */
export function asUri(uri: Uri): api.Uri {
  return uri as unknown as api.Uri;
}

export function asDocument(doc: TextDocument): api.TextDocument {
  return doc as unknown as api.TextDocument;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function asFileSystemError(error: unknown): FileSystemError {
  if (hasCode(error, "ENOENT")) {
    return FileSystemError.FileNotFound();
  }
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
    return FileSystemError.NoPermissions();
  }
  return new FileSystemError("Unknown", error instanceof Error ? error.message : String(error));
}

async function walk(dir: string, found: string[]): Promise<void> {
  let entries: nodeFs.Dirent[];
  try {
    entries = await nodeFs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      directories.push(full);
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  await Promise.all(directories.map((child) => walk(child, found)));
}

function containingFolder(uri: Uri): WorkspaceFolder | undefined {
  return state.folders.find((folder) => {
    const relative = nodePath.relative(folder.uri.fsPath, uri.fsPath);
    return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
  });
}

async function applyOperation(operation: EditOperation): Promise<boolean> {
  const open = state.documents.find(
    (doc) => doc.uri.toString() === operation.uri.toString() && !doc.isClosed,
  );
  if (operation.kind === "replace") {
    if (!open) {
      return false;
    }
    const text = open.getText();
    const start = open.offsetAt(operation.range.start);
    const end = open.offsetAt(operation.range.end);
    open.setText(text.slice(0, start) + operation.text + text.slice(end));
    // A workspace edit leaves the buffer unsaved, so disk stays as it was.
    open.isDirty = true;
    return true;
  }
  if (operation.kind === "create") {
    const exists = nodeFs.existsSync(operation.uri.fsPath);
    if (exists && !operation.overwrite) {
      return false;
    }
    await nodeFs.promises.mkdir(nodePath.dirname(operation.uri.fsPath), { recursive: true });
    await nodeFs.promises.writeFile(operation.uri.fsPath, operation.contents ?? new Uint8Array());
    return true;
  }
  try {
    await nodeFs.promises.rm(operation.uri.fsPath, { recursive: true });
  } catch (error) {
    if (!(hasCode(error, "ENOENT") && operation.ignoreIfNotExists)) {
      return false;
    }
  }
  if (open) {
    closeDocument(open);
  }
  return true;
}

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] | undefined {
    return state.folders.length > 0 ? state.folders : undefined;
  },

  get textDocuments(): TextDocument[] {
    return state.documents;
  },

  fs: {
    async stat(uri: Uri): Promise<{ type: number; ctime: number; mtime: number; size: number }> {
      try {
        const stat = await nodeFs.promises.stat(uri.fsPath);
        return {
          type: stat.isDirectory() ? FileType.Directory : FileType.File,
          ctime: stat.birthtimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
        };
      } catch (error) {
        throw asFileSystemError(error);
      }
    },

    async readFile(uri: Uri): Promise<Uint8Array> {
      try {
        return new Uint8Array(await nodeFs.promises.readFile(uri.fsPath));
      } catch (error) {
        throw asFileSystemError(error);
      }
    },

    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      await nodeFs.promises.mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await nodeFs.promises.writeFile(uri.fsPath, content);
    },

    async delete(uri: Uri, options?: { recursive?: boolean }): Promise<void> {
      await nodeFs.promises.rm(uri.fsPath, { recursive: options?.recursive ?? false });
    },
  },

  /**
   * Returns every file under the open folders. The real API also applies the exclude glob, but
   * the model re-filters through `WorkspaceFilter`, so leaving it out only widens the input.
   */
  async findFiles(_include: string, _exclude?: string): Promise<Uri[]> {
    const found: string[] = [];
    await Promise.all(state.folders.map((folder) => walk(folder.uri.fsPath, found)));
    return found.sort().map((fsPath) => Uri.file(fsPath));
  },

  getConfiguration(section: string): {
    get: <T>(key: string, fallback: T) => T;
    inspect: <T>(key: string) => {
      globalValue: T | undefined;
      workspaceValue: T | undefined;
      workspaceFolderValue: undefined;
    };
    update: (key: string, value: unknown, target?: number) => Promise<void>;
  } {
    const scoped = (key: string): string => `${section}.${key}`;
    return {
      // Workspace scope outranks user scope, the way the real precedence chain resolves.
      get<T>(key: string, fallback: T): T {
        const value =
          state.workspaceConfiguration.get(scoped(key)) ?? state.configuration.get(scoped(key));
        return value === undefined ? fallback : (value as T);
      },
      inspect<T>(key: string): {
        globalValue: T | undefined;
        workspaceValue: T | undefined;
        workspaceFolderValue: undefined;
      } {
        return {
          globalValue: state.configuration.get(scoped(key)) as T | undefined,
          workspaceValue: state.workspaceConfiguration.get(scoped(key)) as T | undefined,
          // The fake has no per-folder scope; multi-root settings files are out of its reach.
          workspaceFolderValue: undefined,
        };
      },
      update(key: string, value: unknown, target?: number): Promise<void> {
        const store =
          target === ConfigurationTarget.Global
            ? state.configuration
            : state.workspaceConfiguration;
        store.set(scoped(key), value);
        return Promise.resolve();
      },
    };
  },

  createFileSystemWatcher(glob: string | RelativePattern): FileSystemWatcher {
    const watcher = new FileSystemWatcher(glob);
    state.watchers.push(watcher);
    return watcher;
  },

  onDidChangeTextDocument(listener: (event: { document: TextDocument }) => unknown) {
    return state.events.documentChanged.event(listener);
  },

  onDidOpenTextDocument(listener: (doc: TextDocument) => unknown) {
    return state.events.documentOpened.event(listener);
  },

  onDidSaveTextDocument(listener: (doc: TextDocument) => unknown) {
    return state.events.documentSaved.event(listener);
  },

  onDidCloseTextDocument(listener: (doc: TextDocument) => unknown) {
    return state.events.documentClosed.event(listener);
  },

  onDidCreateFiles(listener: (event: { files: readonly Uri[] }) => unknown) {
    return state.events.filesCreated.event(listener);
  },

  onDidDeleteFiles(listener: (event: { files: readonly Uri[] }) => unknown) {
    return state.events.filesDeleted.event(listener);
  },

  onDidRenameFiles(listener: (event: { files: readonly FileRename[] }) => unknown) {
    return state.events.filesRenamed.event(listener);
  },

  onDidChangeConfiguration(listener: (event: ConfigurationChangeEvent) => unknown) {
    return state.events.configurationChanged.event(listener);
  },

  onDidChangeWorkspaceFolders(listener: () => unknown) {
    return state.events.foldersChanged.event(listener);
  },

  registerFileSystemProvider(
    scheme: string,
    provider: FileSystemProviderRegistration["provider"],
    options?: FileSystemProviderRegistration["options"],
  ): { dispose: () => void } {
    state.fileSystemProviders.set(scheme, { provider, options });
    return { dispose: () => void state.fileSystemProviders.delete(scheme) };
  },

  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return containingFolder(uri);
  },

  /** The real API defaults the prefix to multi-root only, but honours an explicit `true` always. */
  asRelativePath(target: Uri | string, includeWorkspaceFolder?: boolean): string {
    const uri = typeof target === "string" ? Uri.file(target) : target;
    const folder = containingFolder(uri);
    if (!folder) {
      return uri.fsPath;
    }
    const relative = nodePath.relative(folder.uri.fsPath, uri.fsPath);
    const prefixed = includeWorkspaceFolder ?? state.folders.length > 1;
    return prefixed ? nodePath.join(folder.name, relative) : relative;
  },

  async openTextDocument(uri: Uri): Promise<TextDocument> {
    const open = state.documents.find(
      (doc) => doc.uri.toString() === uri.toString() && !doc.isClosed,
    );
    if (open) {
      return open;
    }
    const registered = state.fileSystemProviders.get(uri.scheme);
    const text = registered
      ? Buffer.from(await registered.provider.readFile(asUri(uri))).toString("utf8")
      : Buffer.from(await workspace.fs.readFile(uri))
          .toString("utf8")
          .replace(/^﻿/, "");
    const doc = new TextDocument(uri, text);
    state.documents.push(doc);
    return doc;
  },

  async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    const results = [];
    for (const operation of edit.operations) {
      results.push(await applyOperation(operation));
    }
    return results.every(Boolean);
  },
};

function detailOf(rest: unknown[]): string | undefined {
  const options = rest.find(
    (item): item is { detail?: unknown } => typeof item === "object" && item !== null,
  );
  return typeof options?.detail === "string" ? options.detail : undefined;
}

/** Records the dialog and returns whatever `state.answer` decides the user picked. */
function show(kind: ShownMessage["kind"], message: string, rest: unknown[]): Promise<undefined> {
  const items = rest.filter((item): item is string => typeof item === "string");
  state.shown.push({ kind, message, items, detail: detailOf(rest) });
  const answer = state.answer(message, items);
  return Promise.resolve(answer as undefined);
}

export const window = {
  get activeTextEditor(): TextEditor | undefined {
    return state.activeTextEditor;
  },

  get visibleTextEditors(): TextEditor[] {
    return state.visibleTextEditors;
  },

  onDidChangeVisibleTextEditors(listener: (editors: TextEditor[]) => unknown): {
    dispose: () => void;
  } {
    return state.visibleEditorsChanged.event(listener);
  },

  createTextEditorDecorationType(options: Record<string, unknown>): TextEditorDecorationType {
    return new TextEditorDecorationType(options);
  },

  createStatusBarItem(alignment: number, priority?: number): StatusBarItem {
    const item = new StatusBarItem(alignment, priority);
    state.statusBarItems.push(item);
    return item;
  },

  createOutputChannel(name: string): OutputChannel {
    const channel = new OutputChannel(name);
    state.outputChannels.push(channel);
    return channel;
  },

  createTreeView(viewId: string, options: unknown): TreeView<unknown> {
    const view = new TreeView<unknown>(viewId, options);
    state.treeViews.push(view);
    return view;
  },

  onDidChangeActiveTextEditor(listener: (target: TextEditor | undefined) => unknown): {
    dispose: () => void;
  } {
    return state.activeEditorChanged.event(listener);
  },

  registerFileDecorationProvider(_provider: unknown): { dispose: () => void } {
    return { dispose: () => undefined };
  },

  showWarningMessage(message: string, ...rest: unknown[]): Promise<undefined> {
    return show("warning", message, rest);
  },

  showInformationMessage(message: string, ...rest: unknown[]): Promise<undefined> {
    return show("information", message, rest);
  },

  showErrorMessage(message: string, ...rest: unknown[]): Promise<undefined> {
    return show("error", message, rest);
  },

  async showTextDocument(
    target: Uri | TextDocument,
    options?: api.TextDocumentShowOptions,
  ): Promise<TextEditor> {
    const doc = target instanceof Uri ? await workspace.openTextDocument(target) : target;
    state.shownDocuments.push(doc.uri);
    // Showing a document both activates it and puts it on screen, so the two stay in step.
    const shown = setActiveEditor(doc, options?.selection?.start.line);
    state.visibleTextEditors = [
      ...state.visibleTextEditors.filter((e) => e.document !== doc),
      ...(shown ? [shown] : []),
    ];
    return shown as TextEditor;
  },

  withProgress<T>(
    _options: unknown,
    task: (
      progress: { report: (value: unknown) => void },
      token: { isCancellationRequested: boolean },
    ) => Promise<T>,
  ): Promise<T> {
    return task({ report: () => undefined }, { isCancellationRequested: false });
  },
};

export const languages = {
  registerCodeLensProvider(_selector: unknown, _provider: unknown): { dispose: () => void } {
    return { dispose: () => undefined };
  },

  setTextDocumentLanguage(doc: TextDocument, languageId: string): Promise<TextDocument> {
    if (doc.isClosed) {
      return Promise.reject(new Error(`Cannot retag a closed document: ${doc.uri.fsPath}`));
    }
    doc.languageId = languageId;
    // The editor retags by reopening the document, so the open event fires again.
    state.events.documentOpened.fire(doc);
    return Promise.resolve(doc);
  },
};

export const commands = {
  registerCommand(
    command: string,
    handler: (...args: never[]) => unknown,
  ): { dispose: () => void } {
    state.commands.set(command, handler);
    return { dispose: () => void state.commands.delete(command) };
  },

  /** Built-in commands have no implementation here, so they are only recorded. */
  async executeCommand(command: string, ...args: never[]): Promise<unknown> {
    state.executed.push({ command, args });
    const handler = state.commands.get(command);
    return handler ? await handler(...args) : undefined;
  },
};

/**
 * The live watchers whose glob is `pattern`, oldest first. Re-watching replaces rather than adds,
 * so a test that wants the current one takes the last.
 */
export function watchersFor(pattern: string): FileSystemWatcher[] {
  return state.watchers.filter(
    (watcher) =>
      !watcher.disposed &&
      (typeof watcher.glob === "string" ? watcher.glob : watcher.glob.pattern) === pattern,
  );
}

/** Raises a settings change that claims to affect exactly `sections` and nothing else. */
export function fireConfigurationChange(...sections: string[]): void {
  state.events.configurationChanged.fire({
    affectsConfiguration: (section) =>
      sections.some((changed) => changed === section || changed.startsWith(`${section}.`)),
  });
}

/** Runs a registered command as the editor would, failing loudly if it was never registered. */
export function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.commands.get(command);
  if (!handler) {
    throw new Error(`command not registered: ${command}`);
  }
  return Promise.resolve(handler(...(args as never[])));
}
