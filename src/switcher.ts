import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ContextManager } from './context';
import { normalise, Store } from './store';
import { Project } from './types';
import { log } from './log';

const PENDING_KEY = 'ctxshift.pending';
const PENDING_MAX_AGE_MS = 90_000;

interface Pending {
  id: string;
  at: number;
}

export function needsWorkspaceFile(p: Project): boolean {
  return p.folders.length > 1 || !!(p.settings && Object.keys(p.settings).length > 0);
}

export class Switcher {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly context: ContextManager
  ) {}

  /** The project that matches the window we are running in, if any. */
  current(): Project | undefined {
    const wf = vscode.workspace.workspaceFile;
    if (wf && wf.scheme === 'file') {
      const wfPath = normalise(wf.fsPath);
      if (wfPath.startsWith(normalise(this.store.workspacesDir) + path.sep)) {
        return this.store.get(path.basename(wf.fsPath, '.code-workspace'));
      }
      return this.store.all().find(p => p.workspaceFile && normalise(p.workspaceFile) === wfPath);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length === 1 && folders[0].uri.scheme === 'file') {
      const n = normalise(folders[0].uri.fsPath);
      return this.store
        .all()
        .find(p => !p.workspaceFile && !needsWorkspaceFile(p) && p.folders[0] && normalise(p.folders[0]) === n);
    }
    return undefined;
  }

  /** What to hand to vscode.openFolder for a project. */
  resolveOpenUri(p: Project): vscode.Uri {
    if (p.workspaceFile) {
      return vscode.Uri.file(p.workspaceFile);
    }
    if (needsWorkspaceFile(p)) {
      fs.mkdirSync(this.store.workspacesDir, { recursive: true });
      const file = path.join(this.store.workspacesDir, `${p.id}.code-workspace`);
      const body = {
        folders: p.folders.map(f => ({ path: f, name: path.basename(f) })),
        settings: p.settings ?? {}
      };
      fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');
      return vscode.Uri.file(file);
    }
    return vscode.Uri.file(p.folders[0]);
  }

  async switchTo(p: Project, newWindow = false, force = false): Promise<void> {
    const cur = this.current();
    const lastSwitch = this.ctx.globalState.get<number>('ctxshift.lastSwitchAt') ?? 0;
    if (!newWindow && Date.now() - lastSwitch < 4000) {
      log(`switch to "${p.name}" ignored: another switch happened ${Date.now() - lastSwitch}ms ago`);
      return;
    }
    log(`switch requested: "${p.name}" (current: ${cur?.name ?? 'none'}, newWindow=${newWindow}, force=${force})`);
    if (!newWindow && !force && cur?.id === p.id) {
      void vscode.window.showInformationMessage(`CtxShift: you are already in "${p.name}".`);
      return;
    }

    const missing = p.workspaceFile
      ? fs.existsSync(p.workspaceFile)
        ? []
        : [p.workspaceFile]
      : p.folders.filter(f => !fs.existsSync(f));
    if (missing.length) {
      const choice = await vscode.window.showErrorMessage(
        `CtxShift: "${p.name}" points to a path that no longer exists: ${missing[0]}`,
        'Remove Project'
      );
      if (choice === 'Remove Project') {
        this.store.remove(p.id);
      }
      return;
    }

    if (!newWindow) {
      // Freeze auto-snapshots, then save the context of the project we are leaving.
      this.context.disarm();
      if (cur) {
        try {
          await this.context.snapshot(cur);
        } catch {
          /* never block a switch on a failed snapshot */
        }
      }
      if (vscode.workspace.getConfiguration('ctxshift').get<boolean>('saveAllBeforeSwitch', true)) {
        await vscode.workspace.saveAll(false);
      }
    }

    await this.ctx.globalState.update('ctxshift.lastSwitchAt', Date.now());
    if (!newWindow && cur && cur.id !== p.id) {
      await this.ctx.globalState.update('ctxshift.previousId', cur.id);
    }
    const pending: Pending = { id: p.id, at: Date.now() };
    await this.ctx.globalState.update(PENDING_KEY, pending);
    this.store.update(p.id, { lastOpened: Date.now() });

    await vscode.commands.executeCommand('vscode.openFolder', this.resolveOpenUri(p), {
      forceNewWindow: newWindow,
      forceReuseWindow: !newWindow
    });
  }

  previous(): Project | undefined {
    const id = this.ctx.globalState.get<string>('ctxshift.previousId');
    return id ? this.store.get(id) : undefined;
  }

  /** If this window was just opened by a CtxShift switch, return the project to restore (once). */
  async takePendingRestore(): Promise<Project | undefined> {
    const pending = this.ctx.globalState.get<Pending>(PENDING_KEY);
    if (!pending) {
      return undefined;
    }
    if (Date.now() - pending.at > PENDING_MAX_AGE_MS) {
      await this.ctx.globalState.update(PENDING_KEY, undefined);
      return undefined;
    }
    const cur = this.current();
    log(`pending restore for ${pending.id}; window is "${cur?.name ?? 'not a known project'}"`);
    if (cur && cur.id === pending.id) {
      await this.ctx.globalState.update(PENDING_KEY, undefined);
      return cur;
    }
    return undefined;
  }
}
