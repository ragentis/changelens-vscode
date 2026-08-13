import * as vscode from "vscode";
import type { ViewMode } from "../config";
import type { ChangeModel, OpaqueReason, PendingFile } from "../model";

const OPAQUE_LABELS: Record<OpaqueReason, string> = {
  binary: "binary",
  tooLarge: "too large",
  lostBaseline: "baseline unavailable",
  unreadableFile: "unreadable on disk",
};

type Node = FolderNode | FileNode;

interface FolderNode {
  type: "folder";
  label: string;
  path: string;
  /** The real directory on disk, so file decorations propagate onto the folder row. */
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

  constructor(private readonly model: ChangeModel) {
    this.subscription = model.onDidChange(() => this.refresh());
    this.refresh();
  }

  private get viewMode(): ViewMode {
    return this.model.config.viewMode;
  }

  refresh(): void {
    this.roots = this.viewMode === "list" ? this.buildList() : this.buildTree();
    this.parents.clear();
    this.byKey.clear();
    this.index(this.roots, undefined);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Indexes the finished tree, because folder compression rewrites nodes after they are built. */
  private index(nodes: Node[], parent: Node | undefined): void {
    for (const node of nodes) {
      if (parent) {
        this.parents.set(node, parent);
      }
      if (node.type === "folder") {
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
    if (!element) {
      return this.roots;
    }
    return element.type === "folder" ? element.children : [];
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.type === "folder") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      if (element.uri) {
        item.resourceUri = element.uri;
      }
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = "changelens.folder";
      return item;
    }

    const file = element.file;
    const item = new vscode.TreeItem(file.uri, vscode.TreeItemCollapsibleState.None);
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
