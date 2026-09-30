import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ContextSnapshot, Project, ProjectsFile } from './types';

const STATE_PREFIX = 'ctxshift.state.';

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Owns projects.json (the project list) and the saved context snapshots. */
export class Store implements vscode.Disposable {
  private projects: Project[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: fs.FSWatcher;
  private ignoreWatchUntil = 0;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.load();
    this.watch();
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('ctxshift.projectsFile')) {
          this.load();
          this.watch();
          this._onDidChange.fire();
        }
      })
    );
  }

  get file(): string {
    const custom = vscode.workspace.getConfiguration('ctxshift').get<string>('projectsFile', '').trim();
    if (custom) {
      return custom.startsWith('~') ? path.join(process.env.HOME || '', custom.slice(1)) : custom;
    }
    return path.join(this.ctx.globalStorageUri.fsPath, 'projects.json');
  }

  get workspacesDir(): string {
    return path.join(this.ctx.globalStorageUri.fsPath, 'workspaces');
  }

  all(): Project[] {
    return this.projects;
  }

  get(id: string): Project | undefined {
    return this.projects.find(p => p.id === id);
  }

  add(p: Omit<Project, 'id'>): Project {
    const project: Project = { id: newId(), ...p };
    this.projects.push(project);
    this.persist();
    return project;
  }

  update(id: string, patch: Partial<Project>): void {
    const p = this.get(id);
    if (!p) {
      return;
    }
    Object.assign(p, patch);
    for (const k of Object.keys(patch) as (keyof Project)[]) {
      if (patch[k] === undefined) {
        delete p[k];
      }
    }
    this.persist();
  }

  remove(id: string): void {
    this.projects = this.projects.filter(p => p.id !== id);
    void this.ctx.globalState.update(STATE_PREFIX + id, undefined);
    this.persist();
  }

  /** Replace the whole ordered list (used by drag and drop). */
  replaceAll(list: Project[]): void {
    this.projects = list;
    this.persist();
  }

  groups(): string[] {
    return [...new Set(this.projects.map(p => p.group).filter((g): g is string => !!g))];
  }

  findByFolder(folder: string): Project | undefined {
    const n = normalise(folder);
    return this.projects.find(p => p.folders.some(f => normalise(f) === n));
  }

  // ---- saved context ----

  getSnapshot(id: string): ContextSnapshot | undefined {
    return this.ctx.globalState.get<ContextSnapshot>(STATE_PREFIX + id);
  }

  async setSnapshot(id: string, snap: ContextSnapshot | undefined): Promise<void> {
    await this.ctx.globalState.update(STATE_PREFIX + id, snap);
  }

  // ---- persistence ----

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as ProjectsFile | Project[];
      const list = Array.isArray(parsed) ? parsed : parsed.projects;
      this.projects = (list ?? [])
        .filter(p => p && Array.isArray(p.folders) && p.name)
        .map(p => ({ ...p, id: p.id || newId() }));
    } catch {
      this.projects = [];
    }
  }

  /** Make sure projects.json exists on disk (so it can be opened and edited). */
  ensureFile(): string {
    if (!fs.existsSync(this.file)) {
      this.persist();
    }
    return this.file;
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data: ProjectsFile = { version: 1, projects: this.projects };
      this.ignoreWatchUntil = Date.now() + 500;
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
      void vscode.window.showErrorMessage(`CtxShift: could not save ${this.file}: ${(e as Error).message}`);
    }
    this._onDidChange.fire();
  }

  private watch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.watcher = fs.watch(path.dirname(this.file), (_evt, name) => {
        if (name !== path.basename(this.file) || Date.now() < this.ignoreWatchUntil) {
          return;
        }
        this.load();
        this._onDidChange.fire();
      });
    } catch {
      /* watching is a nicety; ignore */
    }
  }

  dispose(): void {
    this.watcher?.close();
    this._onDidChange.dispose();
  }
}

export function normalise(p: string): string {
  let n = path.resolve(p);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    n = n.toLowerCase();
  }
  return n.replace(/[\\/]+$/, '');
}
