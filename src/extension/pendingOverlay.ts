/** Prefer pending staged content over disk when present. */
export function resolveReadContent(diskContent: string, pendingContent: string | undefined): string {
  return pendingContent !== undefined ? pendingContent : diskContent;
}
