import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { ContextManager } from './context';
import { PROJECT_COLORS, PROJECT_ICONS, SIDEBAR_VIEWS } from './icons';
import { normalise, Store } from './store';
import { Switcher } from './switcher';
import { GroupNode, ProjectNode, ago } from './tree';
import { Project } from './types';

const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'composer.json', 'Gemfile', 'mix.exs', 'deno.json', 'pubspec.yaml', '.vscode', 'Makefile'
];

interface Deps {
  store: Store;
  switcher: Switcher;
  context: ContextManager;
}

type Arg = ProjectNode | { project: Project } | undefined;

export function registerCommands(ctx: vscode.ExtensionContext, d: Deps): void {
  const { store, switcher, context } = d;
  const reg = (id: string, fn: (...a: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ------------------------------------------------------------ helpers

  const projectFrom = async (arg: Arg, placeHolder = 'Choose a project'): Promise<Project | undefined> => {
    if (arg && 'project' in arg) {
      return arg.project;
    }
    const items = store.all().map(p => ({ label: `$(${p.icon || 'folder'}) ${p.name}`, description: p.group, detail: p.folders[0], p }));
    if (!items.length) {
      void vscode.window.showInformationMessage('CtxShift: you have no projects yet.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDetail: true }))?.p;
  };

  const askName = (value: string, prompt = 'Project name') =>
    vscode.window.showInputBox({ prompt, value, validateInput: v => (v.trim() ? undefined : 'A name is required') });

  const addOne = (folders: string[], name: string, extra: Partial<Project> = {}): Project | undefined => {
    if (!extra.workspaceFile && folders.length === 1) {
      const dup = store.findByFolder(folders[0]);
      if (dup) {
        void vscode.window.showInformationMessage(`CtxShift: "${dup.name}" already points to that folder.`);
        return undefined;
      }
    }
    return store.add({ name, folders, ...extra });
  };

  const pickGroup = async (current?: string): Promise<{ group?: string } | undefined> => {
    const groups = store.groups();
    type Item = vscode.QuickPickItem & { value?: string; kind2?: 'new' | 'none' };
    const items: Item[] = [
      { label: '$(add) New group…', kind2: 'new' },
      { label: '$(close) No group', kind2: 'none' },
      ...(groups.length ? [{ label: 'Existing groups', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
      ...groups.map(g => ({ label: `$(folder-library) ${g}`, description: g === current ? 'current' : undefined, value: g }))
    ];
    const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Group' });
    if (!sel) {
      return undefined;
    }
    if (sel.kind2 === 'none') {
      return { group: undefined };
    }
    if (sel.kind2 === 'new') {
      const name = await vscode.window.showInputBox({ prompt: 'Group name' });
      return name?.trim() ? { group: name.trim() } : undefined;
    }
    return { group: sel.value };
  };

  const pickFolders = (title: string, many = true) =>
    vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: many, openLabel: 'Select', title });

  // ------------------------------------------------------------ switching

  reg('ctxshift.switch', () => showSwitcher(store, switcher, ctx));
  reg('ctxshift.switchToProject', async (arg: Arg) => {
    const p = await projectFrom(arg, 'Switch to project');
    if (p) {
      await switcher.switchTo(p);
    }
  });
  reg('ctxshift.switchPrevious', async () => {
    const p = switcher.previous();
    if (!p) {
      void vscode.window.showInformationMessage('CtxShift: no previous project yet. Switch once and this jumps back.');
      return;
    }
    await switcher.switchTo(p);
  });
  reg('ctxshift.switchToFavorite', async (n: number) => {
    const favs = store.all().filter(p => p.favorite);
    const p = favs[(Number(n) || 1) - 1];
    if (!p) {
      void vscode.window.showInformationMessage(`CtxShift: you have no favourite in slot ${n}. Star a project to add it.`);
      return;
    }
    await switcher.switchTo(p);
  });
  reg('ctxshift.openInNewWindow', async (arg: Arg) => {
    const p = await projectFrom(arg, 'Open project in a new window');
    if (p) {
      await switcher.switchTo(p, true);
    }
  });

  // ------------------------------------------------------------ adding

  reg('ctxshift.addCurrentFolder', async () => {
    const wf = vscode.workspace.workspaceFile;
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    if (wf && wf.scheme === 'file' && !wf.fsPath.startsWith(store.workspacesDir)) {
      const name = await askName(path.basename(wf.fsPath, '.code-workspace'));
      if (name) {
        addOne([path.dirname(wf.fsPath)], name.trim(), { workspaceFile: wf.fsPath });
      }
      return;
    }
    if (!folders.length) {
      void vscode.window.showInformationMessage('CtxShift: open a folder first, or use "Add Project…".');
      return;
    }
    const name = await askName(folders.length > 1 ? `${path.basename(folders[0])} + ${folders.length - 1}` : path.basename(folders[0]));
    if (name) {
      addOne(folders, name.trim());
    }
  });

  reg('ctxshift.addProject', async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: true,
      canSelectMany: true,
      openLabel: 'Add Project',
      title: 'Choose project folders (or a .code-workspace file)',
      filters: { 'VS Code workspace': ['code-workspace'] }
    });
    if (!uris?.length) {
      return;
    }
    const ws = uris.filter(u => u.fsPath.endsWith('.code-workspace'));
    const dirs = uris.filter(u => !u.fsPath.endsWith('.code-workspace')).map(u => u.fsPath);
    for (const w of ws) {
      addOne([path.dirname(w.fsPath)], path.basename(w.fsPath, '.code-workspace'), { workspaceFile: w.fsPath });
    }
    if (dirs.length === 1) {
      const name = await askName(path.basename(dirs[0]));
      if (name) {
        addOne(dirs, name.trim());
      }
    } else if (dirs.length > 1) {
      const mode = await vscode.window.showQuickPick(
        [
          { label: `$(files) ${dirs.length} separate projects`, value: 'many' },
          { label: `$(folder-library) One project with ${dirs.length} folders`, description: 'multi-root', value: 'one' }
        ],
        { placeHolder: 'How should these folders be added?' }
      );
      if (mode?.value === 'many') {
        dirs.forEach(f => addOne([f], path.basename(f)));
      } else if (mode?.value === 'one') {
        const name = await askName(`${path.basename(dirs[0])} + ${dirs.length - 1}`);
        if (name) {
          addOne(dirs, name.trim());
        }
      }
    }
  });

  reg('ctxshift.createProject', async () => {
    const parent = (await pickFolders('Where should the new project live?', false))?.[0];
    if (!parent) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: `New project folder inside ${parent.fsPath}`,
      validateInput: v => {
        if (!v.trim()) {
          return 'A name is required';
        }
        if (/[\\/]/.test(v)) {
          return 'Use a plain folder name';
        }
        return fs.existsSync(path.join(parent.fsPath, v.trim())) ? 'That folder already exists' : undefined;
      }
    });
    if (!name) {
      return;
    }
    const dir = path.join(parent.fsPath, name.trim());
    fs.mkdirSync(dir, { recursive: true });
    const git = await vscode.window.showQuickPick(['Initialise a git repository', 'Skip'], { placeHolder: 'Git' });
    if (git === 'Initialise a git repository') {
      await new Promise<void>(res => execFile('git', ['init'], { cwd: dir }, () => res()));
    }
    const p = addOne([dir], name.trim());
    if (p) {
      const go = await vscode.window.showInformationMessage(`CtxShift: created "${p.name}".`, 'Open Now');
      if (go) {
        await switcher.switchTo(p);
      }
    }
  });

  reg('ctxshift.scanFolder', async () => {
    const parent = (await pickFolders('Choose a folder that contains your projects', false))?.[0];
    if (!parent) {
      return;
    }
    const known = new Set(store.all().flatMap(p => p.folders.map(normalise)));
    const entries = fs
      .readdirSync(parent.fsPath, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => path.join(parent.fsPath, e.name))
      .filter(f => !known.has(normalise(f)));
    const items = entries
      .map(f => {
        const marker = PROJECT_MARKERS.find(m => fs.existsSync(path.join(f, m)));
        return { label: `$(folder) ${path.basename(f)}`, description: marker ? `found ${marker}` : '', f, picked: !!marker };
      })
      .sort((a, b) => Number(b.picked) - Number(a.picked) || a.label.localeCompare(b.label));
    if (!items.length) {
      void vscode.window.showInformationMessage('CtxShift: no new folders found there.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select the folders to add as projects',
      title: `Scan ${parent.fsPath}`
    });
    chosen?.forEach(c => addOne([c.f], path.basename(c.f)));
    if (chosen?.length) {
      void vscode.window.showInformationMessage(`CtxShift: added ${chosen.length} project${chosen.length === 1 ? '' : 's'}.`);
    }
  });

  reg('ctxshift.addFolderToProject', async (arg: Arg) => {
    const p = await projectFrom(arg, 'Add a folder to which project?');
    if (!p) {
      return;
    }
    const picked = await pickFolders(`Add folders to "${p.name}"`);
    if (!picked?.length) {
      return;
    }
    const have = new Set(p.folders.map(normalise));
    const add = picked.map(u => u.fsPath).filter(f => !have.has(normalise(f)));
    if (!add.length) {
      return;
    }
    store.update(p.id, { folders: [...p.folders, ...add] });
    if (switcher.current()?.id === p.id) {
      const go = await vscode.window.showInformationMessage(
        `CtxShift: "${p.name}" now has ${p.folders.length} folders. Reopen it to show them?`,
        'Reopen Now'
      );
      if (go) {
        await switcher.switchTo(store.get(p.id)!, false, true);
      }
    }
  });

  // ------------------------------------------------------------ editing

  reg('ctxshift.editProject', async (arg: Arg) => {
    const start = await projectFrom(arg, 'Edit which project?');
    if (!start) {
      return;
    }
    for (;;) {
      const p = store.get(start.id);
      if (!p) {
        return;
      }
      type Item = vscode.QuickPickItem & { field?: string };
      const items: Item[] = [
        { label: '$(edit) Name', description: p.name, field: 'name' },
        { label: '$(note) Description', description: p.description ?? 'none', field: 'description' },
        { label: '$(folder-library) Group', description: p.group ?? 'none', field: 'group' },
        { label: `$(${p.icon || 'folder'}) Icon`, description: p.icon ?? 'default', field: 'icon' },
        { label: '$(symbol-color) Colour', description: PROJECT_COLORS.find(c => c.id === p.color)?.label ?? 'default', field: 'color' },
        { label: '$(layout-sidebar-left) Sidebar view after switching', description: SIDEBAR_VIEWS.find(v => v.id === p.sidebarView)?.label ?? 'unchanged', field: 'sidebar' },
        { label: '$(root-folder) Add folder…', description: `${p.folders.length} folder${p.folders.length === 1 ? '' : 's'}`, field: 'addFolder' },
        ...(p.folders.length > 1 && !p.workspaceFile ? [{ label: '$(remove) Remove a folder…', field: 'removeFolder' } as Item] : []),
        { label: '$(settings-gear) Settings overrides…', description: 'opens projects.json', field: 'settings' }
      ];
      const sel = await vscode.window.showQuickPick(items, { title: `Edit "${p.name}"`, placeHolder: 'Choose what to change (Esc when done)' });
      if (!sel) {
        return;
      }
      switch (sel.field) {
        case 'name': {
          const v = await askName(p.name);
          if (v) {
            store.update(p.id, { name: v.trim() });
          }
          break;
        }
        case 'description': {
          const v = await vscode.window.showInputBox({ prompt: 'Short description (leave empty to clear)', value: p.description ?? '' });
          if (v !== undefined) {
            store.update(p.id, { description: v.trim() || undefined });
          }
          break;
        }
        case 'group': {
          const g = await pickGroup(p.group);
          if (g) {
            store.update(p.id, { group: g.group });
          }
          break;
        }
        case 'icon': {
          const pick = await vscode.window.showQuickPick(
            [{ label: '$(discard) Default', id: undefined as string | undefined }, ...PROJECT_ICONS.map(i => ({ label: `$(${i.id}) ${i.label}`, id: i.id as string | undefined }))],
            { placeHolder: 'Choose an icon' }
          );
          if (pick) {
            store.update(p.id, { icon: pick.id });
          }
          break;
        }
        case 'color': {
          const pick = await vscode.window.showQuickPick(
            [{ label: '$(discard) Default', id: undefined as string | undefined }, ...PROJECT_COLORS.map(c => ({ label: `$(circle-filled) ${c.label}`, id: c.id as string | undefined }))],
            { placeHolder: 'Choose an icon colour' }
          );
          if (pick) {
            store.update(p.id, { color: pick.id });
          }
          break;
        }
        case 'sidebar': {
          const pick = await vscode.window.showQuickPick(
            [{ label: '$(discard) Leave unchanged', id: undefined as string | undefined }, ...SIDEBAR_VIEWS.map(v => ({ label: v.label, id: v.id as string | undefined }))],
            { placeHolder: 'Which sidebar view should open after switching to this project?' }
          );
          if (pick) {
            store.update(p.id, { sidebarView: pick.id });
          }
          break;
        }
        case 'addFolder':
          await vscode.commands.executeCommand('ctxshift.addFolderToProject', { project: p });
          break;
        case 'removeFolder': {
          const pick = await vscode.window.showQuickPick(p.folders.map(f => ({ label: path.basename(f), description: f, f })), { placeHolder: 'Remove which folder?' });
          if (pick) {
            store.update(p.id, { folders: p.folders.filter(f => f !== pick.f) });
          }
          break;
        }
        case 'settings':
          await openProjectsFile(store, p.id);
          return;
      }
    }
  });

  const setFavorite = (value: boolean) => async (arg: Arg, all?: Arg[]) => {
    const list = all?.length ? all : [arg];
    for (const a of list) {
      const p = await projectFrom(a);
      if (p) {
        store.update(p.id, { favorite: value ? true : undefined });
      }
    }
  };
  reg('ctxshift.favorite', setFavorite(true));
  reg('ctxshift.unfavorite', setFavorite(false));

  reg('ctxshift.removeProject', async (arg: Arg, all?: Arg[]) => {
    const list = (all?.length ? all : [arg]).filter((a): a is ProjectNode => a instanceof ProjectNode);
    const targets = list.length ? list.map(n => n.project) : [await projectFrom(arg, 'Remove which project?')].filter((p): p is Project => !!p);
    if (!targets.length) {
      return;
    }
    const label = targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} projects`;
    const ok = await vscode.window.showWarningMessage(`Remove ${label} from CtxShift?`, { modal: true, detail: 'Your folders and files are not touched. Saved context for the project is forgotten.' }, 'Remove');
    if (ok) {
      targets.forEach(t => store.remove(t.id));
    }
  });

  reg('ctxshift.renameGroup', async (node: GroupNode) => {
    if (!(node instanceof GroupNode)) {
      return;
    }
    const v = await vscode.window.showInputBox({ prompt: 'Group name', value: node.name });
    if (v?.trim()) {
      store.replaceAll(store.all().map(p => (p.group === node.name ? { ...p, group: v.trim() } : p)));
    }
  });
  reg('ctxshift.deleteGroup', (node: GroupNode) => {
    if (node instanceof GroupNode) {
      store.replaceAll(store.all().map(p => {
        if (p.group === node.name) {
          const { group: _g, ...rest } = p;
          return rest;
        }
        return p;
      }));
    }
  });

  // ------------------------------------------------------------ saved context

  const targetForState = async (arg: Arg) => (arg ? projectFrom(arg) : switcher.current());

  reg('ctxshift.saveState', async (arg: Arg) => {
    const p = await targetForState(arg);
    if (!p || switcher.current()?.id !== p.id) {
      void vscode.window.showInformationMessage('CtxShift: a context can only be saved for the project open in this window.');
      return;
    }
    const s = await context.snapshot(p);
    if (s) {
      const tabs = s.groups.reduce((n, g) => n + g.tabs.length, 0);
      void vscode.window.setStatusBarMessage(`$(check) CtxShift saved ${tabs} tabs, ${s.terminals.length} terminals for ${p.name}`, 4000);
    }
  });
  reg('ctxshift.restoreState', async (arg: Arg) => {
    const p = await targetForState(arg);
    if (!p) {
      return;
    }
    const snap = store.getSnapshot(p.id);
    if (!snap) {
      void vscode.window.showInformationMessage(`CtxShift: nothing saved for "${p.name}" yet.`);
      return;
    }
    if (switcher.current()?.id !== p.id) {
      void vscode.window.showInformationMessage(`CtxShift: switch to "${p.name}" first, its context is restored automatically.`);
      return;
    }
    const msg = await context.restore(p, snap);
    void vscode.window.setStatusBarMessage(`$(history) CtxShift: ${msg} (saved ${ago(snap.savedAt)})`, 5000);
  });
  reg('ctxshift.clearState', async (arg: Arg) => {
    const p = await targetForState(arg);
    if (p) {
      await store.setSnapshot(p.id, undefined);
      void vscode.commands.executeCommand('ctxshift.refresh');
    }
  });

  // ------------------------------------------------------------ misc

  reg('ctxshift.revealInOS', async (arg: Arg) => {
    const p = await projectFrom(arg);
    if (p) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p.workspaceFile ?? p.folders[0]));
    }
  });
  reg('ctxshift.copyPath', async (arg: Arg) => {
    const p = await projectFrom(arg);
    if (p) {
      await vscode.env.clipboard.writeText(p.folders.join('\n'));
      void vscode.window.setStatusBarMessage('$(check) Path copied', 2000);
    }
  });
  reg('ctxshift.openProjectsFile', () => openProjectsFile(store));
  reg('ctxshift.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:CodeMaman.ctxshift'));

  reg('ctxshift.exportProjects', async () => {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(process.env.HOME || '', 'ctxshift-projects.json')), filters: { JSON: ['json'] } });
    if (target) {
      fs.writeFileSync(target.fsPath, JSON.stringify({ version: 1, projects: store.all() }, null, 2));
      void vscode.window.showInformationMessage(`CtxShift: exported ${store.all().length} projects.`);
    }
  });

  reg('ctxshift.importProjects', async () => {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, openLabel: 'Import' });
    if (!pick?.[0]) {
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(pick[0].fsPath, 'utf8'));
      const list: any[] = Array.isArray(raw) ? raw : raw.projects ?? [];
      let added = 0;
      for (const item of list) {
        // Understands CtxShift exports and the Project Manager extension's projects.json.
        const folders: string[] = Array.isArray(item.folders) ? item.folders : item.rootPath ? [item.rootPath] : [];
        if (!item.name || !folders.length || item.enabled === false) {
          continue;
        }
        const extra: Partial<Project> = {
          description: item.description,
          group: item.group ?? (Array.isArray(item.tags) ? item.tags[0] : undefined),
          icon: item.icon,
          color: item.color,
          favorite: item.favorite || undefined,
          settings: item.settings,
          workspaceFile: item.workspaceFile
        };
        Object.keys(extra).forEach(k => (extra as any)[k] === undefined && delete (extra as any)[k]);
        if (folders.length === 1 && !extra.workspaceFile && store.findByFolder(folders[0])) {
          continue;
        }
        store.add({ name: String(item.name), folders, ...extra });
        added++;
      }
      void vscode.window.showInformationMessage(`CtxShift: imported ${added} project${added === 1 ? '' : 's'}.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`CtxShift: could not import that file: ${(e as Error).message}`);
    }
  });
}

async function openProjectsFile(store: Store, focusId?: string): Promise<void> {
  const file = store.ensureFile();
  const doc = await vscode.workspace.openTextDocument(file);
  const ed = await vscode.window.showTextDocument(doc);
  if (focusId) {
    const pos = doc.positionAt(doc.getText().indexOf(focusId));
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

// ---------------------------------------------------------------- quick pick switcher

type SwitchItem = vscode.QuickPickItem & { project?: Project; action?: string };

async function showSwitcher(store: Store, switcher: Switcher, _ctx: vscode.ExtensionContext): Promise<void> {
  const cur = switcher.current();
  const qp = vscode.window.createQuickPick<SwitchItem>();
  qp.placeholder = 'Switch project…  (type to search)';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const buttons = (p: Project): vscode.QuickInputButton[] => [
    { iconPath: new vscode.ThemeIcon(p.favorite ? 'star-full' : 'star-empty'), tooltip: p.favorite ? 'Remove from favourites' : 'Add to favourites' },
    { iconPath: new vscode.ThemeIcon('multiple-windows'), tooltip: 'Open in new window' },
    { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit project' }
  ];

  const build = (): SwitchItem[] => {
    const toItem = (p: Project): SwitchItem => ({
      label: `$(${p.id === cur?.id ? 'folder-active' : p.icon || (p.folders.length > 1 ? 'root-folder' : 'folder')}) ${p.name}`,
      description: [p.id === cur?.id ? 'current' : '', p.description ?? ''].filter(Boolean).join(' · '),
      detail: p.folders.length > 1 ? p.folders.map(f => path.basename(f)).join(', ') : p.folders[0],
      buttons: buttons(p),
      project: p
    });
    const sep = (label: string): SwitchItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const projects = store.all();
    const items: SwitchItem[] = [];
    const favs = projects.filter(p => p.favorite);
    if (favs.length) {
      items.push(
        sep('Favourites'),
        ...favs.map((p, i) => {
          const it = toItem(p);
          if (i < 9) {
            it.description = [it.description, `slot ${i + 1}`].filter(Boolean).join(' · ');
          }
          return it;
        })
      );
    }
    const recent = projects
      .filter(p => !p.favorite && p.lastOpened)
      .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))
      .slice(0, 3);
    if (recent.length) {
      items.push(sep('Recent'), ...recent.map(toItem));
    }
    const shown = new Set([...favs, ...recent].map(p => p.id));
    for (const g of store.groups()) {
      const inGroup = projects.filter(p => p.group === g && !shown.has(p.id));
      if (inGroup.length) {
        items.push(sep(g), ...inGroup.map(toItem));
      }
    }
    const rest = projects.filter(p => !p.group && !shown.has(p.id));
    if (rest.length) {
      items.push(sep('Projects'), ...rest.map(toItem));
    }
    items.push(sep('Manage'));
    if (!cur && vscode.workspace.workspaceFolders?.length) {
      items.push({ label: '$(root-folder) Add current folder as project', action: 'ctxshift.addCurrentFolder' });
    }
    items.push(
      { label: '$(add) Add project…', action: 'ctxshift.addProject' },
      { label: '$(search) Scan a folder for projects…', action: 'ctxshift.scanFolder' },
      { label: '$(new-folder) Create new project…', action: 'ctxshift.createProject' }
    );
    return items;
  };

  qp.items = build();
  const active = qp.items.find(i => i.project && i.project.id !== cur?.id);
  if (active) {
    qp.activeItems = [active];
  }

  qp.onDidAccept(() => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (sel?.project) {
      void switcher.switchTo(sel.project);
    } else if (sel?.action) {
      void vscode.commands.executeCommand(sel.action);
    }
  });
  qp.onDidTriggerItemButton(e => {
    const p = e.item.project;
    if (!p) {
      return;
    }
    const idx = (e.item.buttons ?? []).indexOf(e.button);
    if (idx === 0) {
      store.update(p.id, { favorite: p.favorite ? undefined : true });
      qp.items = build();
    } else if (idx === 1) {
      qp.hide();
      void switcher.switchTo(p, true);
    } else if (idx === 2) {
      qp.hide();
      void vscode.commands.executeCommand('ctxshift.editProject', { project: p });
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
