import * as vscode from "vscode";
import type { ViewMode } from "../config";
import type { ChangeModel, OpaqueReason, PendingFile } from "../model";
import { toTreeUri } from "./schemes";

const OPAQUE_LABELS: Record<OpaqueReason, string> = {
  binary: "binary",
  tooLarge: "too large",
  lostBaseline: "baseline unavailable",
  unreadableFile: "unreadable on disk",
};

type Node = FolderNode | FileNode;
export type ChangesNode = Node;

/** How soon after VS Code last asked for rows a reported collapse is taken as its own, not the user's. */
const SETTLING_MS = 300;

interface FolderNode {
  type: "folder";
  label: string;
  path: string;
  /** The directory path under the tree-only scheme, so only ChangeLens decorates this row. */
  uri: vscode.Uri | undefined;
  children: Node[];
}

interface FileNode {
  type: "file";
  file: PendingFile;
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly subscription: vscode.Disposable;
  private roots: Node[] = [];
  private readonly parents = new Map<Node, Node>();
  private readonly byKey = new Map<string, FileNode>();
  private readonly byPath = new Map<string, FolderNode>();
  /** Part of every row id; a bump makes VS Code discard the nodes it holds instead of reusing them. */
  private generation = 0;
  private visible = true;
  /** The roots VS Code last asked for, which is what it has drawn. */
  private fetched: Node[] | undefined;
  /** The folders of the current rows whose children VS Code has asked for since the rebuild. */
  private fetchedFolders = new Set<FolderNode>();
  /** Folder paths the user collapsed, whose children VS Code does not ask for on a rebuild. */
  private readonly collapsed = new Set<string>();
  private lastFetchAt = 0;

  constructor(private readonly model: ChangeModel) {
    this.subscription = model.onDidChange(() => this.refresh());
    this.refresh();
  }

  private get viewMode(): ViewMode {
    return this.model.config.viewMode;
  }

  /**
   * VS Code holds every refresh sent to a hidden view and applies them all when it is shown, so
   * nothing is sent while hidden. What the show then needs is decided by the caller from
   * {@link isDrawn}, once VS Code's own fetching has settled.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** Whether VS Code has ever asked for the rows, which it first does when the panel is shown. */
  everFetched(): boolean {
    return this.fetched !== undefined;
  }

  /** Whether VS Code has fetched every row of the current build it would draw. */
  isDrawn(): boolean {
    return this.undrawn().length === 0;
  }

  /**
   * The folders whose rows VS Code has not fetched since the last rebuild, or `the top level`
   * when it never asked for the rows at all. VS Code fetches the children of every expanded folder
   * after a refresh, so a folder missing here is drawn empty or left collapsed.
   */
  undrawn(): string[] {
    if (this.fetched !== this.roots) {
      return ["the top level"];
    }
    const missing: string[] = [];
    const visit = (nodes: Node[]): void => {
      for (const node of nodes) {
        if (node.type !== "folder" || this.collapsed.has(node.path)) {
          continue;
        }
        if (this.fetchedFolders.has(node)) {
          visit(node.children);
        } else {
          missing.push(node.path);
        }
      }
    };
    visit(this.roots);
    return missing;
  }

  /** Tracks the folders VS Code will not ask for, which {@link undrawn} must not wait for. */
  setCollapsed(node: Node, collapsed: boolean): void {
    if (node.type !== "folder") {
      return;
    }
    if (!collapsed) {
      this.collapsed.delete(node.path);
      return;
    }
    // VS Code collapses a folder itself when it gives up on getting its rows, and reports that
    // the same way as a click. Honouring it would keep the folder collapsed on every rebuild.
    if (this.sinceLastFetch() < SETTLING_MS) {
      return;
    }
    this.collapsed.add(node.path);
  }

  /** A key for the row that survives a rebuild, which replaces every node. */
  selectionKey(node: Node | undefined): string | undefined {
    if (!node) {
      return undefined;
    }
    return node.type === "folder" ? `d:${node.path}` : `f:${node.file.key}`;
  }

  nodeForSelection(key: string): Node | undefined {
    const value = key.slice(2);
    return key.startsWith("d:") ? this.byPath.get(value) : this.byKey.get(value);
  }

  /** Milliseconds since VS Code last asked for rows, which is how drawing in progress shows. */
  sinceLastFetch(): number {
    return Date.now() - this.lastFetchAt;
  }

  /** Rebuilds the rows from the model, and repaints them when the panel is on screen. */
  refresh(): void {
    this.build();
  }

  /**
   * Rebuilds with rows VS Code cannot match to the ones it drew, so it discards every node it
   * holds instead of reusing them. A reused node keeps what VS Code left on it: a folder it
   * collapsed after giving up on its rows stays collapsed and is never fetched again. The cost is the
   * selection, which the caller restores.
   */
  rebuild(): void {
    this.generation += 1;
    this.build();
  }

  private build(): void {
    this.roots = this.viewMode === "list" ? this.buildList() : this.buildTree();
    this.parents.clear();
    this.byKey.clear();
    this.byPath.clear();
    this.fetchedFolders = new Set();
    this.index(this.roots, undefined);
    if (this.visible) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  /** Indexes the finished tree, because folder compression rewrites nodes after they are built. */
  private index(nodes: Node[], parent: Node | undefined): void {
    for (const node of nodes) {
      if (parent) {
        this.parents.set(node, parent);
      }
      if (node.type === "folder") {
        this.byPath.set(node.path, node);
        this.index(node.children, node);
      } else {
        this.byKey.set(node.file.key, node);
      }
    }
  }

  /** Required for `TreeView.reveal`, which expands a row by walking up to the root. */
  getParent(element: Node): Node | undefined {
    return this.parents.get(element);
  }

  /** Reveal works on node identity, and every refresh replaces the nodes, so look them up fresh. */
  nodeForKey(key: string): Node | undefined {
    return this.byKey.get(key);
  }

  private buildList(): Node[] {
    return this.model.files.map((file) => ({ type: "file", file }));
  }

  private buildTree(): Node[] {
    const root: FolderNode = { type: "folder", label: "", path: "", uri: undefined, children: [] };
    const folders = new Map<string, FolderNode>([["", root]]);

    for (const file of this.model.files) {
      const segments = relativeSegments(file.uri);
      const directories = segments.slice(0, -1);
      let cursor = root;
      for (const [depth, segment] of directories.entries()) {
        const path = cursor.path ? `${cursor.path}/${segment}` : segment;
        let next = folders.get(path);
        if (!next) {
          next = {
            type: "folder",
            label: segment,
            path,
            uri: ancestorOf(file.uri, directories.length - depth),
            children: [],
          };
          folders.set(path, next);
          cursor.children.push(next);
        }
        cursor = next;
      }
      cursor.children.push({ type: "file", file });
    }

    compressFolders(root);
    return root.children;
  }

  getChildren(element?: Node): Node[] {
    this.lastFetchAt = Date.now();
    if (!element) {
      this.fetched = this.roots;
      return this.roots;
    }
    if (element.type !== "folder") {
      return [];
    }
    this.fetchedFolders.add(element);
    return element.children;
  }

  getTreeItem(element: Node): vscode.TreeItem {
    this.lastFetchAt = Date.now();
    if (element.type === "folder") {
      const state = this.collapsed.has(element.path)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(element.label, state);
      item.id = `${this.generation}/d/${element.path}`;
      if (element.uri) {
        item.resourceUri = toTreeUri(element.uri);
      }
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "changelens.folder";
      return item;
    }

    const file = element.file;
    const item = new vscode.TreeItem(toTreeUri(file.uri), vscode.TreeItemCollapsibleState.None);
    item.id = `${this.generation}/f/${file.key}`;
    item.label = basename(file.uri.path);
    item.description = describe(file, this.viewMode === "list");
    item.contextValue = "changelens.file";
    item.tooltip = `${vscode.workspace.asRelativePath(file.uri)} — ${file.status}`;
    // Opaque files open too: the command falls back to whatever of them can be shown.
    item.command = {
      command: "changelens.openDiff",
      title: "Open Change",
      arguments: [file.key],
    };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

function compressFolders(folder: FolderNode): void {
  for (const child of folder.children) {
    if (child.type === "folder") {
      compressFolders(child);
    }
  }
  folder.children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    const left = a.type === "folder" ? a.label : basename(a.file.uri.path);
    const right = b.type === "folder" ? b.label : basename(b.file.uri.path);
    return left.localeCompare(right);
  });
  for (const [index, child] of folder.children.entries()) {
    if (child.type !== "folder" || child.children.length !== 1) {
      continue;
    }
    const only = child.children[0];
    if (!only || only.type !== "folder") {
      continue;
    }
    folder.children[index] = {
      type: "folder",
      label: `${child.label}/${only.label}`,
      path: only.path,
      uri: only.uri,
      children: only.children,
    };
  }
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * Workspace-relative segments. The folder name is left to `asRelativePath`'s own rule, which adds
 * it only for multi-root workspaces; forcing it on would put a redundant root above every file.
 */
function relativeSegments(uri: vscode.Uri): string[] {
  return vscode.workspace.asRelativePath(uri).replace(/\\/g, "/").split("/");
}

function ancestorOf(uri: vscode.Uri, levels: number): vscode.Uri {
  return vscode.Uri.joinPath(uri, ...Array<string>(levels).fill(".."));
}

function describe(file: PendingFile, includeLocation: boolean): string {
  const location = includeLocation ? dirLabel(file.uri) : "";
  if (file.opaqueReason) {
    return [location, file.status, OPAQUE_LABELS[file.opaqueReason]].filter(Boolean).join(" · ");
  }
  const counts = `+${file.added} −${file.removed}`;
  return [location, counts].filter(Boolean).join(" · ");
}

function dirLabel(uri: vscode.Uri): string {
  return relativeSegments(uri).slice(0, -1).join("/");
}
