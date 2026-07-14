/**
 * Artifact document browser public exports (Task 42).
 */

export {
  ARTIFACT_CATALOG_SCHEMA_VERSION,
  DEFAULT_BROWSE_LIMIT,
  DEFAULT_INLINE_BINARY_BYTES,
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_TEXT_PREVIEW_BYTES,
  LARGE_FILE_THRESHOLD_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_ENTRIES,
  type ArtifactCatalogState,
  type ArtifactListFilter,
  type ArtifactOrigin,
  type ArtifactRecord,
  type ArtifactVersion,
  type BrowseResult,
  type BrowserEntry,
  type ChangeDetectResult,
  type CopyPathResult,
  type DiffLink,
  type EntryKind,
  type EvidenceLink,
  type ExportRequest,
  type ExportResult,
  type ExternalAppKind,
  type ExternalOpenResult,
  type FileFingerprint,
  type OfficeAvailability,
  type PackageRequest,
  type PackageResult,
  type PathStat,
  type PreviewKind,
  type PreviewRange,
  type PreviewResult,
  type RegisterArtifactInput,
  type RevealResult,
  type ReviewStatus,
  type UpdateArtifactInput
} from "./artifactTypes.js";

export {
  PathSafetyError,
  basenameOf,
  extensionOf,
  isInsideRoot,
  parentRelativePath,
  resolveExistingSafePath,
  resolveSafePath,
  safeStat,
  toProjectRelative
} from "./pathSafety.js";

export {
  classifyPreviewKind,
  languageHint,
  looksBinary,
  mimeFor
} from "./previewKinds.js";

export {
  buildStoredZip,
  escapeHtml,
  estimatePdfPageCount,
  previewDocx,
  previewPptx,
  previewXlsx,
  readZipEntries
} from "./zipOoxml.js";

export {
  detectOfficeAvailability,
  openWithExternalApp,
  revealInFileManager
} from "./officeOpen.js";

export {
  ArtifactBrowserService,
  type ArtifactBrowserFs,
  type ArtifactBrowserServiceOptions,
  type ArtifactProjectPort,
  type ArtifactRunPort
} from "./artifactBrowserService.js";

export {
  createArtifactRouteApp,
  createArtifactRouter,
  type ArtifactRouteDeps
} from "./artifactRoutes.js";
