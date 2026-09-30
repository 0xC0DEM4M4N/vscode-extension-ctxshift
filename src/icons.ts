/** Curated line icons (VS Code codicons) a project can use. */
export const PROJECT_ICONS: { id: string; label: string }[] = [
  { id: 'folder', label: 'Folder' },
  { id: 'root-folder', label: 'Root folder' },
  { id: 'folder-library', label: 'Library' },
  { id: 'briefcase', label: 'Work' },
  { id: 'home', label: 'Home' },
  { id: 'rocket', label: 'Rocket' },
  { id: 'beaker', label: 'Experiment' },
  { id: 'bug', label: 'Bug' },
  { id: 'globe', label: 'Web' },
  { id: 'server', label: 'Server' },
  { id: 'database', label: 'Database' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'package', label: 'Package' },
  { id: 'terminal', label: 'CLI' },
  { id: 'symbol-method', label: 'Function' },
  { id: 'extensions', label: 'Extension' },
  { id: 'book', label: 'Docs' },
  { id: 'lightbulb', label: 'Idea' },
  { id: 'heart', label: 'Personal' },
  { id: 'flame', label: 'Hot' },
  { id: 'zap', label: 'Fast' },
  { id: 'gift', label: 'Gift' },
  { id: 'game', label: 'Game' },
  { id: 'device-mobile', label: 'Mobile' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'shield', label: 'Security' },
  { id: 'tools', label: 'Tools' },
  { id: 'graph', label: 'Data' }
];

/** Theme colours that exist in every theme. */
export const PROJECT_COLORS: { id: string; label: string }[] = [
  { id: 'charts.red', label: 'Red' },
  { id: 'charts.orange', label: 'Orange' },
  { id: 'charts.yellow', label: 'Yellow' },
  { id: 'charts.green', label: 'Green' },
  { id: 'charts.blue', label: 'Blue' },
  { id: 'charts.purple', label: 'Purple' }
];

export const SIDEBAR_VIEWS: { id: string; label: string; command: string }[] = [
  { id: 'explorer', label: 'Explorer', command: 'workbench.view.explorer' },
  { id: 'search', label: 'Search', command: 'workbench.view.search' },
  { id: 'scm', label: 'Source Control', command: 'workbench.view.scm' },
  { id: 'debug', label: 'Run and Debug', command: 'workbench.view.debug' },
  { id: 'extensions', label: 'Extensions', command: 'workbench.view.extensions' },
  { id: 'ctxshift', label: 'CtxShift', command: 'workbench.view.extension.ctxshift' }
];
