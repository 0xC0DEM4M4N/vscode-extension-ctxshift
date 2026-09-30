export interface Project {
  id: string;
  name: string;
  /** Absolute folder paths. The first one is the primary folder. */
  folders: string[];
  /** Optional existing .code-workspace file to open instead of the folders. */
  workspaceFile?: string;
  description?: string;
  group?: string;
  /** Codicon id, e.g. "rocket". */
  icon?: string;
  /** Theme colour id, e.g. "charts.blue". */
  color?: string;
  favorite?: boolean;
  /** Which sidebar view to show after a switch. */
  sidebarView?: string;
  /** Workspace settings applied only while this project is open. */
  settings?: Record<string, unknown>;
  lastOpened?: number;
}

export interface ProjectsFile {
  version: 1;
  projects: Project[];
}

export interface TabState {
  kind: 'text' | 'notebook' | 'custom';
  uri: string;
  viewType?: string;
  pinned: boolean;
  active: boolean;
  /** [anchorLine, anchorChar, activeLine, activeChar] */
  selection?: [number, number, number, number];
  topLine?: number;
}

export interface GroupState {
  viewColumn: number;
  active: boolean;
  tabs: TabState[];
}

export interface TerminalState {
  name: string;
  cwd?: string;
  active: boolean;
}

export interface BreakpointState {
  type: 'source' | 'function';
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  uri?: string;
  line?: number;
  column?: number;
  functionName?: string;
}

export interface ContextSnapshot {
  savedAt: number;
  groups: GroupState[];
  layout?: unknown;
  terminals: TerminalState[];
  branch?: string;
  breakpoints: BreakpointState[];
}
