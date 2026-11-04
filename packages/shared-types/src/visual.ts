// Visual intelligence (M4): images to editable LaTeX. Constants shared by the
// database schema, the API contracts and the web app.

export const VISUAL_TASK_TYPES = [
  'auto',
  'equation',
  'handwritten-equation',
  'derivation',
  'diagram',
  'quantum-circuit',
  'electrical-circuit',
  'plot',
  'explanation',
  'caption',
  'text-to-diagram',
] as const;
export type VisualTaskType = (typeof VISUAL_TASK_TYPES)[number];

export const VISUAL_TASK_STATUSES = ['queued', 'running', 'needs_input', 'completed', 'failed', 'cancelled'] as const;
export type VisualTaskStatus = (typeof VISUAL_TASK_STATUSES)[number];

export const VISUAL_ARTIFACT_TYPES = ['equation', 'diagram', 'quantum-circuit', 'electrical-circuit', 'plot', 'explanation'] as const;
export type VisualArtifactType = (typeof VISUAL_ARTIFACT_TYPES)[number];

export const VISUAL_ASSET_KINDS = ['original', 'variant', 'render'] as const;
export type VisualAssetKind = (typeof VISUAL_ASSET_KINDS)[number];

export const VISUAL_ASSET_SOURCES = ['upload', 'clipboard', 'project-file', 'pdf-region', 'generated'] as const;
export type VisualAssetSource = (typeof VISUAL_ASSET_SOURCES)[number];

export const VISUAL_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf'] as const;
export type VisualImageType = (typeof VISUAL_IMAGE_TYPES)[number];

export const PRIVACY_MODES = ['local', 'cloud'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export const COMPILATION_STATUSES = ['not-compiled', 'compiling', 'succeeded', 'failed', 'invalid'] as const;
export type CompilationStatus = (typeof COMPILATION_STATUSES)[number];

export const VERSION_ORIGINS = ['model', 'manual', 'refinement', 'restore', 'calibration'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

export const APPROVAL_STATUSES = ['draft', 'approved'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const INSERTION_STATUSES = ['applied', 'rolled-back'] as const;
export type InsertionStatus = (typeof INSERTION_STATUSES)[number];

/** Where an image came from. A PDF region keeps the paper, page and box it was cut from. */
export type VisualProvenance =
  | { source: 'upload' | 'clipboard'; fileName: string | null }
  | { source: 'project-file'; projectId: string; path: string }
  | {
      source: 'pdf-region';
      attachmentId: string;
      libraryItemId: string;
      pdfSha256: string;
      pageNumber: number;
      /** Canonical M3.3 box (PDF points, CropBox-relative, top-left, unrotated). */
      region: { x: number; y: number; width: number; height: number; pageWidth: number; pageHeight: number };
      /** Scale the browser rendered the page at before cropping. */
      renderScale: number;
    }
  | { source: 'generated'; fromAssetId: string | null; description: string };

/** One preprocessing step; a variant stores the ordered list applied to its parent. */
export type PreprocessOperation =
  /** Apply the camera's EXIF orientation (photos of notes and whiteboards). */
  | { op: 'auto-orient' }
  /** Any angle; small angles straighten a skewed photo (manual deskew). */
  | { op: 'rotate'; degrees: number }
  | { op: 'crop'; left: number; top: number; width: number; height: number }
  | { op: 'resize'; maxWidth: number; maxHeight: number }
  | { op: 'grayscale' }
  | { op: 'contrast'; factor: number }
  | { op: 'normalize' }
  | { op: 'sharpen' }
  | { op: 'upscale'; factor: number };

export const PREPROCESS_VERSION = '1';
