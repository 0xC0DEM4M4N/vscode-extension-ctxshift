import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { ContextSnapshot, Project } from './types';

const MIME = 'application/vnd.code.tree.ctxshift.projects';
export const FAVORITES = 'Favourites';

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group' as const;
  constructor(public readonly name: string, public readonly isFavorites = false) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `group:${name}`;
    this.contextValue = isFavorites ? 'favorites' : 'group';
    this.iconPath = new vscode.ThemeIcon(isFavorites ? 'star-full' : 'folder-library');
  }
}

export class ProjectNode extends vscode.TreeItem {
  readonly kind = 'project' as const;
  constructor(public readonly project: Project, isCurrent: boolean, snapshot: ContextSnapshot | undefined, inFavorites: boolean) {
    super(project.name, vscode.TreeItemCollapsibleState.None);
    this.id = `${inFavorites ? 'fav:' : ''}project:${project.id}`;

    const paths = project.workspaceFile ? [project.workspaceFile] : project.folders;
    const missing = paths.some(p => !fs.existsSync(p));
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const short = (p: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);

    const bits: string[] = [];
    if (isCurrent) {
      bits.push('current');
    }
    if (missing) {
      bits.push('folder missing');
    } else if (project.description) {
      bits.push(project.description);
    } else if (project.folders.length > 1) {
      bits.push(`${project.folders.length} folders`);
    } else {
      bits.push(short(project.folders[0] ?? ''));
    }
    this.description = bits.join(' · ');

    const iconId = missing
      ? 'warning'
      : isCurrent
        ? 'folder-active'
        : project.icon || (project.folders.length > 1 || project.workspaceFile ? 'root-folder' : 'folder');
    const color = missing
      ? 'list.warningForeground'
      : isCurrent
        ? 'charts.green'
        : project.color;
    this.iconPath = new vscode.ThemeIcon(iconId, color ? new vscode.ThemeColor(color) : undefined);

    const tags = ['project'];
    if (project.favorite) {
      tags.push('fav');
    }
    if (isCurrent) {
      tags.push('current');
    }
    this.contextValue = tags.join('.');

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${project.name}**\n\n`);
    if (project.description) {
      md.appendMarkdown(`${project.description}\n\n`);
    }
    for (const f of paths) {
      md.appendMarkdown(`- \`${f}\`\n`);
    }
    if (project.group) {
      md.appendMarkdown(`\nGroup: ${project.group}\n`);
    }
    if (snapshot) {
      const tabs = snapshot.groups.reduce((n, g) => n + g.tabs.length, 0);
      md.appendMarkdown(
        `\n$(history) Saved context: ${tabs} tabs, ${snapshot.terminals.length} terminals` +
          (snapshot.branch ? `, branch \`${snapshot.branch}\`` : '') +
          ` (${ago(snapshot.savedAt)})\n`
      );
    }
    if (project.lastOpened) {
      md.appendMarkdown(`\nLast opened ${ago(project.lastOpened)}\n`);
    }
    this.tooltip = md;

    if (!isCurrent) {
      this.command = { command: 'ctxshift.switchToProject', title: 'Switch to Project', arguments: [this] };
    }
  }
}

export type Node = GroupNode | ProjectNode;

export class ProjectsProvider implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node> {
  readonly dragMimeTypes = [MIME];
  readonly dropMimeTypes = [MIME];
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: Store, private readonly currentId: () => string | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  getChildren(parent?: Node): Node[] {
    const projects = this.store.all();
    const cur = this.currentId();
    const node = (p: Project, fav = false) => new ProjectNode(p, p.id === cur, this.store.getSnapshot(p.id), fav);

    if (!parent) {
      const out: Node[] = [];
      if (projects.some(p => p.favorite)) {
        out.push(new GroupNode(FAVORITES, true));
      }
      for (const g of this.store.groups()) {
        out.push(new GroupNode(g));
      }
      for (const p of projects.filter(p => !p.group)) {
        out.push(node(p));
      }
      return out;
    }
    if (parent instanceof GroupNode) {
      return parent.isFavorites
        ? projects.filter(p => p.favorite).map(p => node(p, true))
        : projects.filter(p => p.group === parent.name).map(p => node(p));
    }
    return [];
  }

  // ---- drag and drop: reorder, regroup, favourite ----

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const ids = source.filter((s): s is ProjectNode => s.kind === 'project').map(s => s.project.id);
    if (ids.length) {
      data.set(MIME, new vscode.DataTransferItem(ids));
    }
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(MIME);
    if (!item) {
      return;
    }
    const ids = new Set<string>(item.value as string[]);
    const all = this.store.all();
    const dragged = all.filter(p => ids.has(p.id));
    if (!dragged.length) {
      return;
    }

    if (target instanceof GroupNode && target.isFavorites) {
      dragged.forEach(p => (p.favorite = true));
      this.store.replaceAll([...all]);
      return;
    }

    let group: string | undefined;
    let beforeId: string | undefined;
    if (target instanceof GroupNode) {
      group = target.name;
    } else if (target instanceof ProjectNode) {
      group = target.project.group;
      beforeId = target.project.id;
    }
    if (beforeId && ids.has(beforeId)) {
      return;
    }
    dragged.forEach(p => {
      if (group) {
        p.group = group;
      } else {
        delete p.group;
      }
    });
    const rest = all.filter(p => !ids.has(p.id));
    const at = beforeId ? rest.findIndex(p => p.id === beforeId) : rest.length;
    rest.splice(at < 0 ? rest.length : at, 0, ...dragged);
    this.store.replaceAll(rest);
  }
}

// ---------------------------------------------------------------- Saved Context view

class CtxNode extends vscode.TreeItem {
  children?: CtxNode[];
}

export class ContextProvider implements vscode.TreeDataProvider<CtxNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CtxNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: Store, private readonly current: () => Project | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(n: CtxNode): vscode.TreeItem {
    return n;
  }

  getChildren(parent?: CtxNode): CtxNode[] {
    if (parent) {
      return parent.children ?? [];
    }
    const p = this.current();
    const snap = p && this.store.getSnapshot(p.id);
    if (!p) {
      return [];
    }
    if (!snap) {
      const n = new CtxNode('Nothing saved yet');
      n.description = 'saves automatically as you work';
      n.iconPath = new vscode.ThemeIcon('info');
      return [n];
    }
    const out: CtxNode[] = [];
    let seq = 0;
    const leaf = (label: string, icon: string, description?: string): CtxNode => {
      const n = new CtxNode(label, vscode.TreeItemCollapsibleState.None);
      n.id = `ctx:${p.id}:${label}:${seq++}`;
      n.iconPath = new vscode.ThemeIcon(icon);
      n.description = description;
      return n;
    };
    const section = (label: string, icon: string, description: string, kids: CtxNode[]): CtxNode => {
      const n = new CtxNode(label, kids.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      n.id = `ctx:${p.id}:section:${label}`;
      n.iconPath = new vscode.ThemeIcon(icon);
      n.description = description;
      n.children = kids;
      return n;
    };

    out.push(leaf('Saved', 'history', ago(snap.savedAt)));
    if (snap.branch) {
      out.push(leaf('Branch', 'git-branch', snap.branch));
    }

    const tabNodes: CtxNode[] = [];
    let total = 0;
    for (const g of snap.groups) {
      for (const t of g.tabs) {
        total++;
        const uri = vscode.Uri.parse(t.uri);
        const n = leaf(path.basename(uri.fsPath), t.pinned ? 'pinned' : 'file', snap.groups.length > 1 ? `column ${g.viewColumn}` : undefined);
        n.resourceUri = uri;
        n.iconPath = vscode.ThemeIcon.File;
        n.tooltip = uri.fsPath;
        n.command = { command: 'vscode.open', title: 'Open', arguments: [uri] };
        tabNodes.push(n);
      }
    }
    out.push(
      section('Editors', 'files', `${total} tab${total === 1 ? '' : 's'}${snap.groups.length > 1 ? ` in ${snap.groups.length} groups` : ''}`, tabNodes)
    );
    out.push(
      section(
        'Terminals',
        'terminal',
        `${snap.terminals.length}`,
        snap.terminals.map(t => leaf(t.name, 'terminal', t.cwd ? path.basename(t.cwd) : undefined))
      )
    );
    out.push(
      section(
        'Breakpoints',
        'debug-breakpoint',
        `${snap.breakpoints.length}`,
        snap.breakpoints.map(b =>
          b.type === 'source'
            ? leaf(`${path.basename(vscode.Uri.parse(b.uri ?? '').fsPath)}:${(b.line ?? 0) + 1}`, 'debug-breakpoint', b.condition)
            : leaf(b.functionName ?? 'function', 'debug-breakpoint-function')
        )
      )
    );
    return out;
  }
}

export function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) {
    return 'just now';
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m} min ago`;
  }
  const h = Math.round(m / 60);
  if (h < 24) {
    return `${h} h ago`;
  }
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
