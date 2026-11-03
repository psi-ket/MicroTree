/** Open the literature page, remembering the project to return to. */
export function openLiterature(fromProjectId?: string): void {
  window.location.hash = fromProjectId ? `/literature?from=${fromProjectId}` : '/literature';
}

/** Open the library, remembering the project to return to. */
export function openLibrary(fromProjectId?: string): void {
  window.location.hash = fromProjectId ? `/library?from=${fromProjectId}` : '/library';
}
