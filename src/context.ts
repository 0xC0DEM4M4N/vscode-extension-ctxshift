import * as vscode from 'vscode';
import * as fs from 'fs';
import { Store } from './store';
import { SIDEBAR_VIEWS } from './icons';
import { checkoutBranch, currentBranch } from './git';
import { log } from './log';
import {
  BreakpointState,
  ContextSnapshot,
  GroupState,
  Project,
  TabState,
  TerminalState
} from './types';

const AUTO_SNAPSHOT_DELAY_MS = 3000;

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('ctxshift').get<T>(key, fallback);
}

function isRestorableUri(u: vscode.Uri): boolean {
  return u.scheme === 'file' || u.scheme === 'vscode-remote';
}

/**
 * Captures and restores the "context" of a project: tabs, layout, terminals,
 * git branch and breakpoints.
 */
export class ContextManager implements vscode.Disposable {
  private readonly cursors = new Map<string, { sel: [number, number, number, number]; top: number }>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  private armed = false;
  private restoring = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly store: Store,
    private readonly getCurrent: () => Project | undefined
  ) {
    const schedule = () => this.schedule();
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        this.trackCursor(e.textEditor);
        schedule();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(e => this.trackCursor(e.textEditor)),
      vscode.window.tabGroups.onDidChangeTabs(schedule),
      vscode.window.tabGroups.onDidChangeTabGroups(schedule),
      vscode.window.onDidOpenTerminal(schedule),
      vscode.window.onDidCloseTerminal(schedule),
      vscode.debug.onDidChangeBreakpoints(schedule),
      this._onDidChange
    );
  }

  /** Start auto-snapshotting after startup has settled (so an empty window never overwrites a saved context). */
  arm(afterMs = 6000): void {
    setTimeout(() => {
      this.armed = true;
    }, afterMs);
  }

  disarm(): void {
    this.armed = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private trackCursor(ed: vscode.TextEditor): void {
    const sel = ed.selection;
    this.cursors.set(ed.document.uri.toString(), {
      sel: [sel.anchor.line, sel.anchor.character, sel.active.line, sel.active.character],
      top: ed.visibleRanges[0]?.start.line ?? sel.active.line
    });
  }

  private schedule(): void {
    if (!this.armed || this.restoring || !cfg('autoSnapshot', true) || !this.getCurrent()) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      const p = this.getCurrent();
      if (p && this.armed && !this.restoring) {
        void this.snapshot(p);
      }
    }, AUTO_SNAPSHOT_DELAY_MS);
  }

  // ---------------------------------------------------------------- capture

  async capture(project: Project): Promise<ContextSnapshot> {
    const groups: GroupState[] = [];
    if (cfg('restore.editors', true)) {
      for (const g of vscode.window.tabGroups.all) {
        const tabs: TabState[] = [];
        for (const t of g.tabs) {
          const input = t.input;
          let uri: vscode.Uri | undefined;
          let kind: TabState['kind'] | undefined;
          let viewType: string | undefined;
          if (input instanceof vscode.TabInputText) {
            uri = input.uri;
            kind = 'text';
          } else if (input instanceof vscode.TabInputNotebook) {
            uri = input.uri;
            kind = 'notebook';
            viewType = input.notebookType;
          } else if (input instanceof vscode.TabInputCustom) {
            uri = input.uri;
            kind = 'custom';
            viewType = input.viewType;
          }
          if (!uri || !kind || !isRestorableUri(uri)) {
            continue;
          }
          const cur = this.cursors.get(uri.toString());
          tabs.push({
            kind,
            uri: uri.toString(),
            viewType,
            pinned: t.isPinned,
            active: t.isActive,
            selection: kind === 'text' ? cur?.sel : undefined,
            topLine: kind === 'text' ? cur?.top : undefined
          });
        }
        groups.push({ viewColumn: g.viewColumn, active: g.isActive, tabs });
      }
    }

    let layout: unknown;
    if (cfg('restore.layout', true)) {
      try {
        layout = await vscode.commands.executeCommand('vscode.getEditorLayout');
      } catch {
        layout = undefined;
      }
    }

    const terminals: TerminalState[] = [];
    if (cfg('restore.terminals', true)) {
      const active = vscode.window.activeTerminal;
      for (const t of vscode.window.terminals) {
        const opts = t.creationOptions as vscode.TerminalOptions & vscode.ExtensionTerminalOptions;
        if (t.exitStatus !== undefined || opts.pty) {
          continue;
        }
        const shellCwd = t.shellIntegration?.cwd;
        const optCwd = opts.cwd;
        const cwd = shellCwd
          ? shellCwd.fsPath
          : typeof optCwd === 'string'
            ? optCwd
            : optCwd?.fsPath;
        terminals.push({ name: t.name, cwd, active: t === active });
      }
    }

    const breakpoints: BreakpointState[] = [];
    if (cfg('restore.breakpoints', true)) {
      for (const b of vscode.debug.breakpoints) {
        const base = { enabled: b.enabled, condition: b.condition, hitCondition: b.hitCondition, logMessage: b.logMessage };
        if (b instanceof vscode.SourceBreakpoint) {
          if (!isRestorableUri(b.location.uri)) {
            continue;
          }
          breakpoints.push({
            type: 'source',
            ...base,
            uri: b.location.uri.toString(),
            line: b.location.range.start.line,
            column: b.location.range.start.character
          });
        } else if (b instanceof vscode.FunctionBreakpoint) {
          breakpoints.push({ type: 'function', ...base, functionName: b.functionName });
        }
      }
    }

    const branch = cfg('restore.branch', true) ? await currentBranch(project.folders[0]) : undefined;

    return { savedAt: Date.now(), groups, layout, terminals, branch, breakpoints };
  }

  /** Capture and persist the current context for a project. */
  async snapshot(project: Project): Promise<ContextSnapshot | undefined> {
    const snap = await this.capture(project);
    const prev = this.store.getSnapshot(project.id);
    if (prev && JSON.stringify({ ...prev, savedAt: 0 }) === JSON.stringify({ ...snap, savedAt: 0 })) {
      return prev;
    }
    await this.store.setSnapshot(project.id, snap);
    // Cursor and scroll movement is saved but must not redraw the sidebar views.
    if (!prev || signature(prev) !== signature(snap)) {
      log(`snapshot saved for "${project.name}" (${signature(snap).length} chars)`);
      this._onDidChange.fire();
    }
    return snap;
  }

  // ---------------------------------------------------------------- restore

  async restore(project: Project, snap: ContextSnapshot): Promise<string> {
    this.restoring = true;
    const notes: string[] = [];
    try {
      let opened = 0;
      let missing = 0;

      // 1. Editors and layout (skipped when VS Code already restored exactly this, which avoids a second flicker)
      const alreadyThere = editorsSignature(currentGroups()) === editorsSignature(snap.groups);
      log(`restore "${project.name}": editors ${alreadyThere ? 'already match, skipping' : 'restoring'}`);
      if (cfg('restore.editors', true) && snap.groups.length > 0 && !alreadyThere) {
        if (cfg('restore.closeOtherEditors', true)) {
          const toClose = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => !t.isDirty);
          if (toClose.length) {
            await vscode.window.tabGroups.close(toClose);
          }
        }
        if (cfg('restore.layout', true) && snap.layout) {
          try {
            await vscode.commands.executeCommand('vscode.setEditorLayout', snap.layout);
          } catch {
            /* keep whatever layout we have */
          }
        }
        let activeTab: { group: GroupState; tab: TabState } | undefined;
        for (const g of snap.groups) {
          for (const t of g.tabs) {
            if (await this.openTab(g.viewColumn, t)) {
              opened++;
              if (t.pinned) {
                await vscode.commands.executeCommand('workbench.action.pinEditor');
              }
            } else {
              missing++;
            }
          }
          const act = g.tabs.find(t => t.active);
          if (act) {
            // Re-activate this group's active tab (it is already open, so this only switches to it).
            await this.openTab(g.viewColumn, act);
            if (g.active) {
              activeTab = { group: g, tab: act };
            }
          }
        }
        if (activeTab) {
          await this.openTab(activeTab.group.viewColumn, activeTab.tab);
        }
        notes.push(`${opened} tab${opened === 1 ? '' : 's'}`);
        if (missing) {
          notes.push(`${missing} missing file${missing === 1 ? '' : 's'} skipped`);
        }
      }

      // 2. Sidebar
      const view = SIDEBAR_VIEWS.find(v => v.id === project.sidebarView);
      if (view) {
        await vscode.commands.executeCommand(view.command);
      }

      // 3. Terminals (skip any that VS Code already brought back)
      if (cfg('restore.terminals', true) && snap.terminals.length) {
        const have = new Set(vscode.window.terminals.map(t => t.name));
        let created = 0;
        let toShow: vscode.Terminal | undefined;
        for (const t of snap.terminals) {
          if (have.has(t.name)) {
            continue;
          }
          const cwd = t.cwd && fs.existsSync(t.cwd) ? t.cwd : project.folders[0];
          const term = vscode.window.createTerminal({ name: t.name, cwd });
          created++;
          if (t.active || !toShow) {
            toShow = term;
          }
        }
        toShow?.show(true);
        if (created) {
          notes.push(`${created} terminal${created === 1 ? '' : 's'}`);
        }
      }

      // 4. Breakpoints
      if (cfg('restore.breakpoints', true) && snap.breakpoints.length) {
        const have = new Set(vscode.debug.breakpoints.map(bpKey));
        const add: vscode.Breakpoint[] = [];
        for (const b of snap.breakpoints) {
          const opts = { condition: b.condition, hitCondition: b.hitCondition, logMessage: b.logMessage };
          let bp: vscode.Breakpoint | undefined;
          if (b.type === 'source' && b.uri !== undefined && b.line !== undefined) {
            bp = new vscode.SourceBreakpoint(
              new vscode.Location(vscode.Uri.parse(b.uri), new vscode.Position(b.line, b.column ?? 0)),
              b.enabled,
              opts.condition,
              opts.hitCondition,
              opts.logMessage
            );
          } else if (b.type === 'function' && b.functionName) {
            bp = new vscode.FunctionBreakpoint(b.functionName, b.enabled, opts.condition, opts.hitCondition, opts.logMessage);
          }
          if (bp && !have.has(bpKey(bp))) {
            add.push(bp);
          }
        }
        if (add.length) {
          vscode.debug.addBreakpoints(add);
          notes.push(`${add.length} breakpoint${add.length === 1 ? '' : 's'}`);
        }
      }

      // 5. Git branch (last, and only when it is safe)
      if (cfg('restore.branch', true) && snap.branch) {
        const result = await checkoutBranch(project.folders[0], snap.branch);
        if (result === 'switched') {
          notes.push(`branch ${snap.branch}`);
        } else if (result === 'dirty') {
          void vscode.window.showWarningMessage(
            `CtxShift: staying on the current branch because it has uncommitted changes (saved branch: ${snap.branch}).`
          );
        } else if (result === 'failed') {
          void vscode.window.showWarningMessage(`CtxShift: could not switch to saved branch "${snap.branch}".`);
        }
      }
    } finally {
      // Give VS Code a moment to fire the resulting change events before auto-snapshots resume.
      setTimeout(() => {
        this.restoring = false;
        this._onDidChange.fire();
      }, 2500);
    }
    return notes.length ? `Restored ${notes.join(', ')}` : 'Nothing to restore';
  }

  private async openTab(viewColumn: number, t: TabState): Promise<boolean> {
    const uri = vscode.Uri.parse(t.uri);
    try {
      if (uri.scheme === 'file' && !fs.existsSync(uri.fsPath)) {
        return false;
      }
      if (t.kind === 'text') {
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, {
          viewColumn: viewColumn as vscode.ViewColumn,
          preview: false,
          preserveFocus: false
        });
        if (t.selection) {
          const [al, ac, cl, cc] = t.selection;
          const max = doc.lineCount - 1;
          ed.selection = new vscode.Selection(
            new vscode.Position(Math.min(al, max), ac),
            new vscode.Position(Math.min(cl, max), cc)
          );
          const top = Math.min(t.topLine ?? cl, max);
          ed.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
        }
      } else if (t.viewType) {
        await vscode.commands.executeCommand('vscode.openWith', uri, t.viewType, {
          viewColumn: viewColumn as vscode.ViewColumn,
          preview: false
        });
      } else {
        await vscode.commands.executeCommand('vscode.open', uri, { viewColumn, preview: false });
      }
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.disposables.forEach(d => d.dispose());
  }
}

function bpKey(b: vscode.Breakpoint): string {
  if (b instanceof vscode.SourceBreakpoint) {
    return `s|${b.location.uri.toString()}|${b.location.range.start.line}|${b.condition ?? ''}`;
  }
  if (b instanceof vscode.FunctionBreakpoint) {
    return `f|${b.functionName}`;
  }
  return `o|${b.id}`;
}

/** Everything that matters structurally, ignoring cursor/scroll and timestamps. */
function signature(s: ContextSnapshot): string {
  return JSON.stringify({
    g: s.groups.map(g => [g.viewColumn, g.tabs.map(t => [t.uri, t.pinned, t.active])]),
    t: s.terminals.map(t => [t.name, t.cwd]),
    b: s.branch,
    bp: s.breakpoints
  });
}

function currentGroups(): { viewColumn: number; tabs: { uri: string }[] }[] {
  return vscode.window.tabGroups.all.map(g => ({
    viewColumn: g.viewColumn,
    tabs: g.tabs.flatMap(t => {
      const i = t.input as { uri?: vscode.Uri } | undefined;
      return i?.uri && isRestorableUri(i.uri) ? [{ uri: i.uri.toString() }] : [];
    })
  }));
}

function editorsSignature(groups: { viewColumn: number; tabs: { uri: string }[] }[]): string {
  return JSON.stringify(groups.filter(g => g.tabs.length).map(g => [g.viewColumn, g.tabs.map(t => t.uri)]));
}
