import type { DocumentContent } from '../shared';

// Every edit is sent immediately; file closing and saving await all outstanding acknowledgments.
const pending = new Map<string, Set<Promise<DocumentContent>>>();
export function persistTeX(id: string, source: string, revision: number) {
  const request = window.desktop!.updateTeXDocument(id, source, revision);
  const requests = pending.get(id) ?? new Set<Promise<DocumentContent>>();
  pending.set(id, requests); requests.add(request);
  void request.finally(() => { requests.delete(request); if (!requests.size) pending.delete(id); }).catch(() => {});
  return request;
}
export async function flushTeX(id?: string) {
  await Promise.all(id ? [...(pending.get(id) ?? [])] : [...pending.values()].flatMap(requests => [...requests]));
}
