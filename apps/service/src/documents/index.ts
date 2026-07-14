/**
 * Document / paper writing workflow (Task 33).
 *
 * Mount later from main/app (out of ownership):
 *
 *   import { DocumentService } from "../documents/index.js";
 *   const docs = await DocumentService.open({
 *     statePath: join(dataDirectory, "documents.json"),
 *     model: modelProvider,
 *     exportDir: join(workspace, "exports"),
 *   });
 */

export {
  DocumentService,
  MaterialImportError,
  OutlineError,
  WritingError,
  type DocumentServiceOptions,
  type CreateDocumentSessionInput,
  type ArtifactWriter
} from "./documentService.js";

export {
  createMaterial,
  importMarkdownText,
  importMarkdownFile,
  importDocxFromBytes,
  importDocxFile,
  importPdfMaterial,
  importPdfMaterialFromBytes,
  materialFromEvidence,
  materialFromProjectFact,
  isOriginalMaterial,
  isGeneratedMaterial,
  hashMaterialText,
  extractDocxTextFromXml,
  extractZipEntryText
} from "./materialImport.js";

export {
  generateOutline,
  buildOutlineContextPack,
  parseOutlineModelOutput,
  outlineFromModelOutput,
  approveOutline,
  rejectOutline,
  assertOutlineApproved
} from "./outline.js";

export {
  writeChapter,
  buildWritingContextPack,
  parseChapterModelOutput,
  applyChapterOutput,
  detectFabricationSignals,
  citationKeyFromEvidence,
  getChapterBody,
  emptyChapter
} from "./writing.js";

export {
  buildCitationsFromEvidence,
  formatCitation,
  formatBibliography,
  checkCitations,
  extractCitationKeysFromBody
} from "./citations.js";

export {
  compareChapterVersions,
  checkConsistency,
  consistencyOk
} from "./consistency.js";

export {
  buildDocumentMarkdown,
  buildDocumentDocx,
  buildDocumentPdf,
  buildZipStore,
  contentHash,
  defaultExportPaths,
  DOCUMENT_MD_KIND,
  DOCUMENT_DOCX_KIND,
  DOCUMENT_PDF_KIND
} from "./exportFormats.js";

export {
  watchFromExport,
  detectExternalChanges,
  hashBuffer,
  defaultFileStatPort,
  type FileStatPort,
  type DetectResult
} from "./externalEdit.js";

export type {
  MaterialKind,
  MaterialFormat,
  ContentOrigin,
  DocumentMaterial,
  OutlineSectionStatus,
  OutlineSection,
  OutlineStatus,
  DocumentOutline,
  ChapterVersion,
  DataPoint,
  Chapter,
  BibliographyStyle,
  Citation,
  ConsistencySeverity,
  ConsistencyIssue,
  DocumentSessionStatus,
  ExportedArtifact,
  ExternalEditWatch,
  DocumentArtifactDescriptor,
  DocumentSession,
  DocumentStateFile,
  VersionDiff,
  CitationCheckFinding,
  CitationCheckResult,
  OutlineModelOutput,
  ChapterModelOutput,
  WriteChapterResult,
  ExportBundleResult,
  ResearchEvidence
} from "./documentTypes.js";
