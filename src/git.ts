import * as vscode from 'vscode';
import { normalise } from './store';

// Minimal typings for the built-in git extension API.
interface GitRepo {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string };
    workingTreeChanges: unknown[];
    indexChanges: unknown[];
    mergeChanges: unknown[];
  };
  checkout(treeish: string): Promise<void>;
}
interface GitApi {
  repositories: GitRepo[];
  onDidOpenRepository: vscode.Event<GitRepo>;
}

async function getApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports?.enabled) {
      return undefined;
    }
    return exports.getAPI(1) as GitApi;
  } catch {
    return undefined;
  }
}

function pick(api: GitApi, folder?: string): GitRepo | undefined {
  if (folder) {
    const n = normalise(folder);
    const exact = api.repositories.find(r => normalise(r.rootUri.fsPath) === n);
    if (exact) {
      return exact;
    }
  }
  return api.repositories[0];
}

/** Find the repository for a folder, waiting a little for git to discover it at startup. */
export async function findRepo(folder?: string, waitMs = 4000): Promise<GitRepo | undefined> {
  const api = await getApi();
  if (!api) {
    return undefined;
  }
  const found = pick(api, folder);
  if (found || waitMs <= 0) {
    return found;
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(pick(api, folder));
    }, waitMs);
    const sub = api.onDidOpenRepository(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(pick(api, folder));
    });
  });
}

export async function currentBranch(folder?: string): Promise<string | undefined> {
  const repo = await findRepo(folder, 0);
  return repo?.state.HEAD?.name;
}

export type CheckoutResult = 'switched' | 'already' | 'dirty' | 'no-repo' | 'failed';

export async function checkoutBranch(folder: string | undefined, branch: string): Promise<CheckoutResult> {
  const repo = await findRepo(folder);
  if (!repo) {
    return 'no-repo';
  }
  if (repo.state.HEAD?.name === branch) {
    return 'already';
  }
  const dirty =
    repo.state.workingTreeChanges.length + repo.state.indexChanges.length + repo.state.mergeChanges.length > 0;
  if (dirty) {
    return 'dirty';
  }
  try {
    await repo.checkout(branch);
    return 'switched';
  } catch {
    return 'failed';
  }
}
