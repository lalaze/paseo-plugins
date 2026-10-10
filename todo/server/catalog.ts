import type { PaseoApi } from '@getpaseo/client';
import { catalogSchema, type Catalog } from '../shared/schema';
import type { GitPort } from './git';

/** Git projects and ready providers for the new-task form. Disabled providers and unselectable models are left out. */
export async function readCatalog(api: PaseoApi): Promise<Catalog> {
  const [projects, snapshot] = await Promise.all([api.projects.list(), api.providers.snapshot()]);
  return catalogSchema.parse({
    projects: projects.projects.filter(project => project.projectKind === 'git').map(project => ({
      projectId: project.projectId,
      name: project.projectDisplayName,
      path: project.projectRootPath,
      kind: project.projectKind,
    })),
    providers: snapshot.entries.filter(entry => entry.status === 'ready' && entry.enabled !== false).map(entry => ({
      provider: entry.provider,
      label: entry.label || entry.provider,
      defaultModeId: entry.defaultModeId ?? null,
      models: (entry.models ?? []).filter(model => model.isSelectable !== false).map(model => ({
        id: model.id, label: model.label || model.id, description: model.description,
        thinkingOptions: model.thinkingOptions?.map(option => ({
          id: option.id, label: option.label || option.id, description: option.description, isDefault: option.isDefault,
        })),
        defaultThinkingOptionId: model.defaultThinkingOptionId,
      })),
      modes: (entry.modes ?? []).map(mode => ({ id: mode.id, label: mode.label || mode.id })),
    })),
  });
}

/** Local branch names and the current HEAD, resolved from the repository root. */
export async function readBranches(git: GitPort, repository: string) {
  const root = await git.resolveRepository(repository);
  return git.listBranches(root);
}
