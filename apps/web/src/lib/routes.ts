/** Open the literature page, remembering the project to return to. */
export function openLiterature(fromProjectId?: string): void {
  window.location.hash = fromProjectId ? `/literature?from=${fromProjectId}` : '/literature';
}

/** Open the library, remembering the project to return to. */
export function openLibrary(fromProjectId?: string): void {
  window.location.hash = fromProjectId ? `/library?from=${fromProjectId}` : '/library';
}

/** Open the Visual Studio (image to LaTeX), remembering the project to return to and insert into. */
export function openVisual(fromProjectId?: string): void {
  window.location.hash = fromProjectId ? `/visual?from=${fromProjectId}` : '/visual';
}

/** Open Evidence Review Mode for a project. */
export function openReview(projectId: string): void {
  window.location.hash = `/review?from=${projectId}`;
}
