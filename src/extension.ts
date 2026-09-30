import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { registerCommands } from './commands';
import { ContextManager } from './context';
import { Store } from './store';
import { Switcher } from './switcher';
import { initLog, log, showLog } from './log';
import { ContextProvider, ProjectsProvider, ago } from './tree';

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  initLog(ctx);
  log(`activated in ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no folder'}`);
  fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });

  const store = new Store(ctx);
  let switcher!: Switcher;
  const context = new ContextManager(store, () => switcher.current());
  switcher = new Switcher(ctx, store, context);
  ctx.subscriptions.push(store, context);

  // ---- views
  const projects = new ProjectsProvider(store, () => switcher.current()?.id);
  const ctxView = new ContextProvider(store, () => switcher.current());
  ctx.subscriptions.push(
    vscode.window.createTreeView('ctxshift.projects', {
      treeDataProvider: projects,
      dragAndDropController: projects,
      canSelectMany: true,
      showCollapseAll: true
    }),
    vscode.window.createTreeView('ctxshift.context', { treeDataProvider: ctxView })
  );

  // ---- status bar
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'ctxshift.switch';
  ctx.subscriptions.push(status);

  const updateStatus = () => {
    const cur = switcher.current();
    if (!vscode.workspace.getConfiguration('ctxshift').get<boolean>('showStatusBar', true)) {
      status.hide();
      return;
    }
    if (cur) {
      status.text = `$(folder-active) ${cur.name}`;
      const snap = store.getSnapshot(cur.id);
      status.tooltip = `CtxShift: ${cur.name}${snap ? `\nContext saved ${ago(snap.savedAt)}` : ''}\nClick to switch project`;
      status.backgroundColor = undefined;
    } else {
      const folder = vscode.workspace.workspaceFolders?.[0];
      status.text = `$(folder) ${folder ? path.basename(folder.uri.fsPath) : 'Projects'}`;
      status.tooltip = 'CtxShift: click to switch project';
    }
    status.show();
  };

  let lastHas = '';
  const refreshAll = () => {
    const cur = switcher.current();
    const has = `${store.all().length > 0}|${!!cur}`;
    if (has !== lastHas) {
      lastHas = has;
      void vscode.commands.executeCommand('setContext', 'ctxshift.hasProjects', store.all().length > 0);
      void vscode.commands.executeCommand('setContext', 'ctxshift.hasCurrent', !!cur);
    }
    projects.refresh();
    ctxView.refresh();
    updateStatus();
  };

  ctx.subscriptions.push(
    store.onDidChange(refreshAll),
    context.onDidChange(() => {
      // Only the Saved Context view and status tooltip change when a snapshot is taken.
      ctxView.refresh();
      updateStatus();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshAll),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('ctxshift')) {
        refreshAll();
      }
    })
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand('ctxshift.refresh', refreshAll),
    vscode.commands.registerCommand('ctxshift.showLog', showLog)
  );

  registerCommands(ctx, { store, switcher, context });
  refreshAll();

  // ---- restore the context of the project we were just switched to
  const mode = vscode.workspace.getConfiguration('ctxshift').get<string>('restoreOnOpen', 'onSwitch');
  const pending = await switcher.takePendingRestore();
  const target = mode === 'never' ? undefined : (pending ?? (mode === 'always' ? switcher.current() : undefined));
  const snap = target && store.getSnapshot(target.id);

  if (target && snap) {
    // Let VS Code finish restoring its own editors, terminals and git before we apply ours.
    setTimeout(async () => {
      const msg = await context.restore(target, snap);
      void vscode.window.setStatusBarMessage(`$(history) CtxShift: ${msg} for ${target.name}`, 6000);
      context.arm(3000);
    }, 700);
  } else {
    context.arm(6000);
  }
}

export function deactivate(): void {
  /* auto-snapshots keep the saved context current; nothing to flush */
}
