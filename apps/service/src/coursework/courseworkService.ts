/**
 * Coursework composite workflow service (Task 34).
 *
 * Orchestrates: spec extract → plan (subtasks) → evidence/scoring map →
 * consistency gates → delivery ZIP → /no-mistakes review → user accept → complete.
 *
 * Optional clients: ResearchService, DocumentService, SubtaskDagService
 * (import types + inject instances; do not own their state).
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelProvider } from "../model/types.js";
import type { ResearchEvidence } from "../research/researchTypes.js";
import type {
  CreateDagFromPlanInput,
  ExplicitSubtaskDef,
  SubtaskDag
} from "../subtasks/subtaskTypes.js";
import type { VerificationEvidence } from "../verification/types.js";
import {
  checkSessionConsistency,
  type ReportClaim
} from "./consistencyGates.js";
import type {
  CourseworkEvidenceItem,
  CourseworkEvidenceKind,
  CourseworkSession,
  CourseworkStateFile,
  DeliveryPackageManifest,
  MissingCriticalInfo,
  NoMistakesReviewResult,
  ProjectScopePolicy,
  ScoringMappingTarget,
  ScoringPointMapping
} from "./courseworkTypes.js";
import {
  buildDeliveryPackage,
  writeDeliveryPackage,
  DELIVERY_ZIP_KIND,
  DELIVERY_README_KIND,
  DELIVERY_MANIFEST_KIND
} from "./deliveryPackage.js";
import {
  mayArchiveComplete,
  reviewCoursework,
  reviewMayAwaitUserAccept
} from "./noMistakesReview.js";
import { planCoursework, toCreateDagFields, PlanCourseworkError } from "./planCoursework.js";
import {
  addMappingTarget,
  bindEvidenceToScoringMap,
  emptyMappings,
  mapFromSpec
} from "./scoringMap.js";
import {
  allCriticalInfoResolved,
  extractSpec,
  resolveMissingInfo,
  SpecExtractError
} from "./specExtract.js";

export interface CourseworkServiceOptions {
  statePath?: string;
  model?: ModelProvider;
  now?: () => Date;
  /** Directory for delivery ZIP and package files. */
  packageDir?: string;
  connectionId?: string;
  modelId?: string;
  /**
   * Optional SubtaskDagService client (Task 21).
   * When set, approvePlan can materialize a DAG.
   */
  subtasks?: {
    createFromApprovedPlan(input: CreateDagFromPlanInput): Promise<SubtaskDag>;
  };
  /**
   * Optional ResearchService-like client (Task 32) — create/link sessions only.
   */
  research?: {
    createSession(input: {
      title: string;
      goal: string;
      runId?: string;
      projectId?: string;
      forceEvidenceMode?: boolean;
    }): Promise<{ id: string }>;
  };
  /**
   * Optional DocumentService-like client (Task 33).
   */
  documents?: {
    createSession(input: {
      title: string;
      goal: string;
      runId?: string;
      projectId?: string;
      researchSessionId?: string;
      projectFacts?: string[];
    }): Promise<{ id: string }>;
  };
}

export interface CreateCourseworkSessionInput {
  title: string;
  goal: string;
  assignmentBrief: string;
  existingProjectNotes?: string;
  runId?: string;
  projectId?: string;
  scopePolicy?: Partial<ProjectScopePolicy>;
}

export interface AddEvidenceInput {
  kind: CourseworkEvidenceKind;
  title: string;
  path?: string;
  contentHash?: string;
  relatedScoringPointIds?: string[];
  relatedRequirementIds?: string[];
  isPlaceholder?: boolean;
  researchEvidenceId?: string;
  verification?: VerificationEvidence;
  metadata?: Record<string, unknown>;
}

function emptyState(): CourseworkStateFile {
  return { schemaVersion: 1, sessions: [] };
}

export class CourseworkService {
  private state: CourseworkStateFile = emptyState();
  private readonly now: () => Date;

  private constructor(
    private readonly statePath: string | undefined,
    state: CourseworkStateFile,
    private readonly model: ModelProvider | undefined,
    now: (() => Date) | undefined,
    private readonly packageDir: string | undefined,
    private readonly connectionId: string | undefined,
    private readonly modelId: string | undefined,
    private readonly subtasks: CourseworkServiceOptions["subtasks"],
    private readonly research: CourseworkServiceOptions["research"],
    private readonly documents: CourseworkServiceOptions["documents"]
  ) {
    this.state = state;
    this.now = now ?? (() => new Date());
  }

  static async open(options: CourseworkServiceOptions = {}): Promise<CourseworkService> {
    let state = emptyState();
    if (options.statePath) {
      try {
        const decoded = JSON.parse(
          await readFile(options.statePath, "utf8")
        ) as Partial<CourseworkStateFile>;
        if (decoded.schemaVersion !== 1) {
          throw new Error("Coursework state is not compatible with this service version.");
        }
        state = {
          schemaVersion: 1,
          sessions: Array.isArray(decoded.sessions)
            ? (decoded.sessions as CourseworkSession[])
            : []
        };
      } catch (error: unknown) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
    }
    return new CourseworkService(
      options.statePath,
      state,
      options.model,
      options.now,
      options.packageDir,
      options.connectionId,
      options.modelId,
      options.subtasks,
      options.research,
      options.documents
    );
  }

  async listSessions(): Promise<CourseworkSession[]> {
    return this.state.sessions.map((s) => structuredClone(s));
  }

  async getSession(sessionId: string): Promise<CourseworkSession> {
    return structuredClone(this.require(sessionId));
  }

  async createSession(input: CreateCourseworkSessionInput): Promise<CourseworkSession> {
    const title = input.title?.trim();
    const goal = input.goal?.trim();
    const brief = input.assignmentBrief?.trim();
    if (!title) throw new Error("title is required.");
    if (!goal) throw new Error("goal is required.");
    if (!brief) throw new Error("assignmentBrief is required.");

    const ts = this.now().toISOString();
    const hasExisting = Boolean(input.existingProjectNotes?.trim());
    const scopePolicy: ProjectScopePolicy = {
      mode: input.scopePolicy?.mode ?? (hasExisting ? "minimal_modify" : "greenfield"),
      retainedFeatures: input.scopePolicy?.retainedFeatures ?? [],
      allowedModificationScope: input.scopePolicy?.allowedModificationScope ??
        (hasExisting ? ["src/**", "tests/**", "README.md"] : ["**/*"]),
      forbiddenPaths: input.scopePolicy?.forbiddenPaths ?? []
    };

    const session: CourseworkSession = {
      id: randomUUID(),
      runId: input.runId,
      projectId: input.projectId,
      title,
      goal,
      status: "collecting_inputs",
      assignmentBrief: brief,
      existingProjectNotes: input.existingProjectNotes?.trim() || undefined,
      scopePolicy,
      planSubtasks: [],
      planApproved: false,
      scoringMap: [],
      evidence: [],
      consistencyFindings: [],
      researchEvidence: [],
      userAccepted: false,
      artifacts: [],
      createdAt: ts,
      updatedAt: ts
    };

    this.state.sessions.push(session);
    await this.persist();
    return structuredClone(session);
  }

  /** Extract requirements / scoring points / prohibitions / delivery / missing info. */
  async extractSpec(sessionId: string): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    const spec = await extractSpec({
      assignmentBrief: session.assignmentBrief,
      existingProjectNotes: session.existingProjectNotes,
      model: this.model,
      connectionId: this.connectionId,
      modelId: this.modelId,
      now: this.now
    });
    session.spec = spec;
    session.scoringMap = mapFromSpec(spec);
    session.status = "spec_extracted";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async resolveMissing(
    sessionId: string,
    missingId: string,
    answer: string
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    if (!session.spec) throw new SpecExtractError("Extract spec first.", "empty_brief");
    session.spec.missingCriticalInfo = resolveMissingInfo(
      session.spec.missingCriticalInfo,
      missingId,
      answer
    );
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /** Secondmate plan → awaiting user approval. */
  async generatePlan(sessionId: string): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    if (!session.spec) {
      throw new PlanCourseworkError("Extract spec before planning.", "no_spec");
    }
    const plan = await planCoursework({
      title: session.title,
      goal: session.goal,
      spec: session.spec,
      existingProjectNotes: session.existingProjectNotes,
      scopeHints: session.scopePolicy,
      model: this.model,
      connectionId: this.connectionId,
      modelId: this.modelId,
      now: this.now
    });
    session.planSubtasks = plan.subtasks;
    session.scopePolicy = plan.scopePolicy;
    session.planApproved = false;
    session.planApprovedAt = undefined;
    session.status = "awaiting_plan_approval";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /**
   * User approves plan. Optionally materializes SubtaskDag via injected client.
   */
  async approvePlan(
    sessionId: string,
    options: { createDag?: boolean; planVersion?: number } = {}
  ): Promise<{ session: CourseworkSession; dag?: SubtaskDag }> {
    const session = this.require(sessionId);
    if (session.status !== "awaiting_plan_approval") {
      throw new PlanCourseworkError(
        "Plan is not awaiting approval.",
        "not_awaiting"
      );
    }
    if (!session.planSubtasks.length) {
      throw new PlanCourseworkError("No plan subtasks to approve.", "no_spec");
    }

    session.planApproved = true;
    session.planApprovedAt = this.now().toISOString();
    session.status = "executing";
    session.updatedAt = session.planApprovedAt;

    let dag: SubtaskDag | undefined;
    if (options.createDag !== false && this.subtasks && session.runId) {
      const fields = toCreateDagFields({
        subtasks: session.planSubtasks,
        scopePolicy: session.scopePolicy,
        taskType: "implementation"
      });
      dag = await this.subtasks.createFromApprovedPlan({
        runId: session.runId,
        planVersion: options.planVersion ?? 1,
        explicitSubtasks: fields.explicitSubtasks,
        taskType: fields.taskType,
        acceptanceCriteria: fields.acceptanceCriteria,
        expectedArtifacts: fields.expectedArtifacts,
        allowedScope: fields.allowedScope,
        planApproved: true,
        autoSchedule: true
      });
      session.dagId = dag.id;
    }

    await this.persist();
    return { session: structuredClone(session), dag };
  }

  async rejectPlan(sessionId: string, reason?: string): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    session.planApproved = false;
    session.planApprovedAt = undefined;
    session.status = "spec_extracted";
    session.updatedAt = this.now().toISOString();
    if (reason) {
      session.artifacts.push({
        path: "plan-rejection",
        kind: "plan-rejection",
        summary: reason
      });
    }
    await this.persist();
    return structuredClone(session);
  }

  /** Link optional research session (create via client if available). */
  async linkResearchSession(
    sessionId: string,
    researchSessionId?: string
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    if (researchSessionId) {
      session.researchSessionId = researchSessionId;
    } else if (this.research) {
      const rs = await this.research.createSession({
        title: `${session.title} — research`,
        goal: session.goal,
        runId: session.runId,
        projectId: session.projectId,
        forceEvidenceMode: true
      });
      session.researchSessionId = rs.id;
    } else {
      throw new Error("researchSessionId required when research client is not configured.");
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async linkDocumentSession(
    sessionId: string,
    documentSessionId?: string
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    if (documentSessionId) {
      session.documentSessionId = documentSessionId;
    } else if (this.documents) {
      const facts = session.spec?.functionalRequirements.map((r) => r.text) ?? [];
      const ds = await this.documents.createSession({
        title: `${session.title} — report`,
        goal: session.goal,
        runId: session.runId,
        projectId: session.projectId,
        researchSessionId: session.researchSessionId,
        projectFacts: facts
      });
      session.documentSessionId = ds.id;
    } else {
      throw new Error("documentSessionId required when documents client is not configured.");
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /** Import ResearchEvidence snapshots for local gates. */
  async importResearchEvidence(
    sessionId: string,
    evidenceList: ResearchEvidence[]
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    for (const ev of evidenceList) {
      if (session.researchEvidence.some((e) => e.id === ev.id)) continue;
      session.researchEvidence.push(structuredClone(ev));
      session.evidence.push({
        id: randomUUID(),
        kind: "research",
        title: ev.title,
        path: ev.source,
        relatedScoringPointIds: [],
        relatedRequirementIds: [],
        researchEvidenceId: ev.id,
        createdAt: this.now().toISOString(),
        metadata: { excerpt: ev.excerpt, origin: ev.origin }
      });
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async addEvidence(
    sessionId: string,
    input: AddEvidenceInput
  ): Promise<{ session: CourseworkSession; evidence: CourseworkEvidenceItem }> {
    const session = this.require(sessionId);
    const item: CourseworkEvidenceItem = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title.trim(),
      path: input.path,
      contentHash: input.contentHash,
      relatedScoringPointIds: input.relatedScoringPointIds ?? [],
      relatedRequirementIds: input.relatedRequirementIds ?? [],
      isPlaceholder: input.isPlaceholder === true,
      researchEvidenceId: input.researchEvidenceId,
      verification: input.verification,
      metadata: input.metadata,
      createdAt: this.now().toISOString()
    };
    if (!item.title) throw new Error("evidence title is required.");
    session.evidence.push(item);

    // Auto-bind scoring map (placeholders never cover)
    session.scoringMap = bindEvidenceToScoringMap(session.scoringMap, session.evidence);
    if (session.status === "executing" || session.status === "mapping_evidence") {
      session.status = "mapping_evidence";
    }
    if (input.verification) {
      session.verificationSummary = input.verification.summary;
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), evidence: structuredClone(item) };
  }

  async mapScoringPoint(
    sessionId: string,
    scoringPointId: string,
    target: ScoringMappingTarget
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    const placeholderRefs = new Set(
      session.evidence
        .filter((e) => e.isPlaceholder)
        .flatMap((e) => [e.id, e.path].filter(Boolean) as string[])
    );
    session.scoringMap = addMappingTarget(session.scoringMap, scoringPointId, target, {
      placeholderRefs
    });
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async setScopePolicy(
    sessionId: string,
    policy: Partial<ProjectScopePolicy>
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    session.scopePolicy = {
      mode: policy.mode ?? session.scopePolicy.mode,
      retainedFeatures: policy.retainedFeatures ?? session.scopePolicy.retainedFeatures,
      allowedModificationScope:
        policy.allowedModificationScope ?? session.scopePolicy.allowedModificationScope,
      forbiddenPaths: policy.forbiddenPaths ?? session.scopePolicy.forbiddenPaths
    };
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async runConsistencyCheck(
    sessionId: string,
    options: {
      reportClaims?: ReportClaim[];
      changedPaths?: string[];
      requireStrongCoverage?: boolean;
    } = {}
  ): Promise<{ session: CourseworkSession; ok: boolean }> {
    const session = this.require(sessionId);
    const result = checkSessionConsistency(session, {
      reportClaims: options.reportClaims,
      changedPaths: options.changedPaths,
      requireStrongCoverage: options.requireStrongCoverage ?? true
    });
    session.consistencyFindings = result.findings;
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), ok: result.ok };
  }

  /** Build runnable package + ZIP (preview allowed before accept). */
  async buildPackage(
    sessionId: string,
    options: { extraFiles?: Array<{ path: string; data: string | Buffer }> } = {}
  ): Promise<{ session: CourseworkSession; manifest: DeliveryPackageManifest; zipBytes: Buffer }> {
    const session = this.require(sessionId);
    session.status = "packaging";

    const outDir = this.packageDir
      ? join(this.packageDir, session.id)
      : undefined;

    const result = outDir
      ? await writeDeliveryPackage({
          session,
          extraFiles: options.extraFiles,
          outputDir: outDir,
          now: this.now
        })
      : buildDeliveryPackage({
          session,
          extraFiles: options.extraFiles,
          now: this.now
        });

    session.delivery = result.manifest;
    session.artifacts = [
      ...session.artifacts.filter(
        (a) =>
          a.kind !== DELIVERY_ZIP_KIND &&
          a.kind !== DELIVERY_README_KIND &&
          a.kind !== DELIVERY_MANIFEST_KIND
      ),
      {
        path: result.manifest.readmePath ?? "README.md",
        kind: DELIVERY_README_KIND,
        summary: "Coursework delivery README"
      },
      {
        path: result.manifest.zipPath ?? "delivery.zip",
        kind: DELIVERY_ZIP_KIND,
        summary: `ZIP hash ${result.manifest.zipContentHash ?? ""}`.trim()
      },
      {
        path: "MANIFEST.json",
        kind: DELIVERY_MANIFEST_KIND,
        summary: `${result.manifest.entries.length} entries`
      }
    ];
    session.updatedAt = this.now().toISOString();
    // Stay in packaging until review; do not complete here
    await this.persist();
    return {
      session: structuredClone(session),
      manifest: structuredClone(result.manifest),
      zipBytes: result.zipBytes
    };
  }

  /** /no-mistakes comprehensive review. */
  async runNoMistakesReview(
    sessionId: string,
    options: {
      reportClaims?: ReportClaim[];
      changedPaths?: string[];
    } = {}
  ): Promise<{ session: CourseworkSession; review: NoMistakesReviewResult }> {
    const session = this.require(sessionId);
    session.status = "reviewing";

    // Refresh consistency findings
    const consistency = checkSessionConsistency(session, {
      reportClaims: options.reportClaims,
      changedPaths: options.changedPaths,
      requireStrongCoverage: true
    });
    session.consistencyFindings = consistency.findings;

    const review = await reviewCoursework({
      session,
      manifest: session.delivery,
      reportClaims: options.reportClaims,
      changedPaths: options.changedPaths,
      consistencyFindings: consistency.findings,
      model: this.model,
      connectionId: this.connectionId,
      modelId: this.modelId,
      now: this.now
    });

    session.review = review;
    if (reviewMayAwaitUserAccept(review)) {
      session.status = "awaiting_user_accept";
    } else {
      session.status = "reviewing";
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return { session: structuredClone(session), review: structuredClone(review) };
  }

  /**
   * User final acceptance. Only then may the session archive as completed.
   */
  async acceptDelivery(
    sessionId: string,
    options: { force?: boolean } = {}
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);

    if (!session.review || session.review.conclusion !== "passed") {
      if (!options.force) {
        throw new Error(
          "Cannot accept: /no-mistakes review has not passed. Fix findings and re-review."
        );
      }
    }
    if (!session.delivery && !options.force) {
      throw new Error("Cannot accept: delivery package has not been built.");
    }

    session.userAccepted = true;
    session.userAcceptedAt = this.now().toISOString();

    if (mayArchiveComplete(session) || options.force) {
      session.status = "completed";
    } else {
      session.status = "awaiting_user_accept";
    }
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  async rejectDelivery(sessionId: string, reason: string): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    session.userAccepted = false;
    session.userAcceptedAt = undefined;
    session.status = "executing";
    session.artifacts.push({
      path: "user-reject",
      kind: "user-reject",
      summary: reason.trim() || "User rejected delivery"
    });
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  /** Replace plan subtasks (advanced / replan). */
  async setPlanSubtasks(
    sessionId: string,
    subtasks: ExplicitSubtaskDef[]
  ): Promise<CourseworkSession> {
    const session = this.require(sessionId);
    session.planSubtasks = subtasks.map((s) => ({ ...s }));
    session.planApproved = false;
    session.status = "awaiting_plan_approval";
    session.updatedAt = this.now().toISOString();
    await this.persist();
    return structuredClone(session);
  }

  getScoringMap(sessionId: string): ScoringPointMapping[] {
    return structuredClone(this.require(sessionId).scoringMap);
  }

  criticalInfoResolved(sessionId: string): boolean {
    const session = this.require(sessionId);
    if (!session.spec) return false;
    return allCriticalInfoResolved(session.spec.missingCriticalInfo);
  }

  private require(sessionId: string): CourseworkSession {
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Coursework session “${sessionId}” not found.`);
    return session;
  }

  private async persist(): Promise<void> {
    if (!this.statePath) return;
    const dir = dirname(this.statePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    try {
      await access(this.statePath, constants.F_OK);
    } catch {
      // new file
    }
    await rename(tmp, this.statePath);
  }
}

export type { MissingCriticalInfo, ReportClaim };
