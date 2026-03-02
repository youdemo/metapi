export type SiteForm = {
  name: string;
  url: string;
  platform: string;
  apiKey: string;
  proxyUrl: string;
};

export type SiteEditorState =
  | { mode: 'add' }
  | { mode: 'edit'; editingSiteId: number };

type SiteSaveAction =
  | { kind: 'add'; payload: SiteForm }
  | { kind: 'update'; id: number; payload: SiteForm };

export function emptySiteForm(): SiteForm {
  return { name: '', url: '', platform: '', apiKey: '', proxyUrl: '' };
}

export function siteFormFromSite(site: Partial<SiteForm> & { proxyUrl?: string | null }): SiteForm {
  return {
    name: site.name ?? '',
    url: site.url ?? '',
    platform: site.platform ?? '',
    apiKey: site.apiKey ?? '',
    proxyUrl: site.proxyUrl ?? '',
  };
}

export function buildSiteSaveAction(editor: SiteEditorState, form: SiteForm): SiteSaveAction {
  if (editor.mode === 'edit') {
    if (!Number.isFinite(editor.editingSiteId)) {
      throw new Error('editingSiteId is required in edit mode');
    }
    return { kind: 'update', id: editor.editingSiteId, payload: form };
  }
  return { kind: 'add', payload: form };
}
