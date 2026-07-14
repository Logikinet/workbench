import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeModelProvider } from "../model/fakeProvider.js";
import { createEvidence } from "../research/evidence.js";
import { buildVerificationEvidence } from "../verification/verificationEvidence.js";
import type { CreateDagFromPlanInput, SubtaskDag } from "../subtasks/subtaskTypes.js";
import { CourseworkService } from "./courseworkService.js";

const BRIEF = `
综合课程设计任务书
功能要求：
1. 用户登录
2. 课程列表
评分标准：
1. 登录功能 30分
2. 课程列表 30分
3. 测试记录 20分
4. 文档报告 20分
禁止项：
1. 不得使用空壳界面冒充功能
交付：ZIP、源码、README、测试记录、截图、可运行项目
`;

describe("CourseworkService integration (task 34)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  const now = () => new Date("2026-04-06T15:00:00.000Z");

  async function open(opts: {
    model?: FakeModelProvider;
    subtasks?: { createFromApprovedPlan(input: CreateDagFromPlanInput): Promise<SubtaskDag> };
    research?: { createSession(input: { title: string; goal: string }): Promise<{ id: string }> };
    documents?: { createSession(input: { title: string; goal: string }): Promise<{ id: string }> };
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "paw-cw-"));
    dirs.push(dir);
    const service = await CourseworkService.open({
      statePath: join(dir, "coursework.json"),
      packageDir: join(dir, "packages"),
      model: opts.model,
      now,
      subtasks: opts.subtasks,
      research: opts.research,
      documents: opts.documents
    });
    return { service, dir };
  }

  it("runs full composite workflow through user accept", async () => {
    const dagCalls: CreateDagFromPlanInput[] = [];
    const { service, dir } = await open({
      subtasks: {
        async createFromApprovedPlan(input) {
          dagCalls.push(input);
          return {
            id: "dag-1",
            runId: input.runId,
            planVersion: input.planVersion,
            createdAt: now().toISOString(),
            updatedAt: now().toISOString(),
            status: "idle",
            subtasks: [],
            autoSchedule: true,
            maxParallelWrite: 1,
            maxParallelRead: 3,
            maxParallelIndependentWrite: 1,
            frontier: [],
            needsAskReplan: false,
            planApproved: true
          };
        }
      },
      research: {
        async createSession() {
          return { id: "research-sess-1" };
        }
      },
      documents: {
        async createSession() {
          return { id: "doc-sess-1" };
        }
      }
    });

    let session = await service.createSession({
      title: "LMS 课设",
      goal: "完成可运行 LMS 课设交付",
      assignmentBrief: BRIEF,
      runId: "run-34",
      projectId: "proj-1",
      existingProjectNotes: [
        "保留: 既有认证中间件",
        "允许修改: src/courses/** 与 tests/**"
      ].join("\n")
    });
    expect(session.status).toBe("collecting_inputs");
    expect(session.scopePolicy.mode).toBe("minimal_modify");

    session = await service.extractSpec(session.id);
    expect(session.status).toBe("spec_extracted");
    expect(session.spec!.scoringPoints.length).toBeGreaterThanOrEqual(3);
    expect(session.scoringMap.length).toBe(session.spec!.scoringPoints.length);

    // resolve missing if any
    for (const m of session.spec!.missingCriticalInfo) {
      session = await service.resolveMissing(session.id, m.id, "answered");
    }

    session = await service.generatePlan(session.id);
    expect(session.status).toBe("awaiting_plan_approval");
    expect(session.planSubtasks.length).toBeGreaterThanOrEqual(5);
    expect(session.planApproved).toBe(false);

    const approved = await service.approvePlan(session.id);
    session = approved.session;
    expect(session.planApproved).toBe(true);
    expect(session.status).toBe("executing");
    expect(session.dagId).toBe("dag-1");
    expect(dagCalls).toHaveLength(1);
    expect(dagCalls[0]!.explicitSubtasks!.length).toBeGreaterThanOrEqual(5);

    session = await service.linkResearchSession(session.id);
    expect(session.researchSessionId).toBe("research-sess-1");
    session = await service.linkDocumentSession(session.id);
    expect(session.documentSessionId).toBe("doc-sess-1");

    const evidence = createEvidence({
      title: "Auth best practices",
      source: "https://example.com/auth",
      excerpt: "Use hashed passwords.",
      origin: "web",
      now
    });
    session = await service.importResearchEvidence(session.id, [evidence]);
    expect(session.researchEvidence).toHaveLength(1);

    const spLogin = session.spec!.scoringPoints.find((s) => /登录|Login/i.test(s.title))
      ?? session.spec!.scoringPoints[0]!;
    const spCourses = session.spec!.scoringPoints.find((s) => /课程|list/i.test(s.title))
      ?? session.spec!.scoringPoints[1]!;
    const spTest = session.spec!.scoringPoints.find((s) => /测试|test/i.test(s.title))
      ?? session.spec!.scoringPoints[2]!;
    const spDocs = session.spec!.scoringPoints.find((s) => /文档|报告|doc/i.test(s.title))
      ?? session.spec!.scoringPoints[session.spec!.scoringPoints.length - 1]!;

    // Fake UI evidence must not cover
    await service.addEvidence(session.id, {
      kind: "screenshot",
      title: "Placeholder shell",
      path: "fake-shell.png",
      relatedScoringPointIds: [spLogin.id],
      isPlaceholder: true
    });

    await service.addEvidence(session.id, {
      kind: "implementation",
      title: "Login module",
      path: "src/auth/login.ts",
      relatedScoringPointIds: [spLogin.id]
    });
    await service.addEvidence(session.id, {
      kind: "implementation",
      title: "Course list",
      path: "src/courses/list.ts",
      relatedScoringPointIds: [spCourses.id]
    });
    const verification = buildVerificationEvidence({
      results: [
        { command: ["npm", "test"], exitCode: 0, stdout: "pass", stderr: "" }
      ],
      stackPrimary: "nodejs"
    });
    await service.addEvidence(session.id, {
      kind: "verification",
      title: "npm test",
      relatedScoringPointIds: [spTest.id, spLogin.id, spCourses.id],
      verification
    });
    await service.addEvidence(session.id, {
      kind: "screenshot",
      title: "Login running UI",
      path: "shots/login.png",
      relatedScoringPointIds: [spLogin.id]
    });
    await service.addEvidence(session.id, {
      kind: "document",
      title: "Report chapter",
      path: "report/ch1.md",
      relatedScoringPointIds: [spDocs.id]
    });
    // Strong coverage for docs scoring — map implementation of README
    await service.mapScoringPoint(session.id, spDocs.id, {
      kind: "implementation_file",
      ref: "README.md",
      note: "Run docs"
    });
    await service.mapScoringPoint(session.id, spDocs.id, {
      kind: "test_record",
      ref: "npm-test-docs",
      note: "doc build check"
    });

    // Ensure every scoring point has strong coverage
    session = await service.getSession(session.id);
    for (const sp of session.spec!.scoringPoints) {
      const m = session.scoringMap.find((x) => x.scoringPointId === sp.id)!;
      const strong = m.targets.some(
        (t) =>
          t.kind === "implementation_file" ||
          t.kind === "run_evidence" ||
          t.kind === "test_record"
      );
      if (!strong) {
        await service.mapScoringPoint(session.id, sp.id, {
          kind: "implementation_file",
          ref: `src/${sp.id}.ts`
        });
        await service.mapScoringPoint(session.id, sp.id, {
          kind: "run_evidence",
          ref: `verify-${sp.id}`
        });
      }
    }

    // Scope retained features for minimal_modify review
    session = await service.setScopePolicy(session.id, {
      retainedFeatures: ["既有认证中间件"],
      allowedModificationScope: ["src/courses/**", "tests/**", "src/auth/**", "README.md"]
    });

    const consistency = await service.runConsistencyCheck(session.id, {
      changedPaths: ["src/courses/list.ts", "tests/login.test.ts"],
      requireStrongCoverage: true
    });
    // Placeholder still present → consistency may fail; remove? For review we keep it
    // but dataAuthenticityOk fails. Drop placeholders by only counting non-placeholder
    // — review fails if any placeholder remains. Remove by rebuilding evidence? 
    // Service has no removeEvidence — filter by not using placeholder for final.
    // Actually reviewCourseworkRules fails if any isPlaceholder in session.evidence.
    // So we need to either not add fake or accept changes_requested first.
    expect(consistency.session.evidence.some((e) => e.isPlaceholder)).toBe(true);

    // Build package (still has placeholder → review should fail authenticity)
    let pack = await service.buildPackage(session.id);
    expect(pack.zipBytes.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(pack.manifest.entries.length).toBeGreaterThan(5);

    let review = await service.runNoMistakesReview(session.id);
    expect(review.review.conclusion).toBe("changes_requested");
    expect(review.review.dataAuthenticityOk).toBe(false);

    // New session path: full happy path without placeholder
    const { service: service2, dir: dir2 } = await open();
    void dir2;
    let s2 = await service2.createSession({
      title: "LMS clean",
      goal: "Deliver",
      assignmentBrief: BRIEF,
      runId: "run-34b"
    });
    s2 = await service2.extractSpec(s2.id);
    s2 = await service2.generatePlan(s2.id);
    s2 = (await service2.approvePlan(s2.id, { createDag: false })).session;

    for (const sp of s2.spec!.scoringPoints) {
      await service2.addEvidence(s2.id, {
        kind: "implementation",
        title: `Impl ${sp.title}`,
        path: `src/${sp.id}.ts`,
        relatedScoringPointIds: [sp.id]
      });
      await service2.addEvidence(s2.id, {
        kind: "verification",
        title: `Verify ${sp.title}`,
        relatedScoringPointIds: [sp.id],
        verification: buildVerificationEvidence({
          results: [{ command: ["npm", "test"], exitCode: 0, stdout: "ok", stderr: "" }],
          stackPrimary: "nodejs"
        })
      });
      await service2.addEvidence(s2.id, {
        kind: "screenshot",
        title: `Shot ${sp.title}`,
        path: `shots/${sp.id}.png`,
        relatedScoringPointIds: [sp.id]
      });
    }

    pack = await service2.buildPackage(s2.id);
    review = await service2.runNoMistakesReview(s2.id);
    expect(review.review.conclusion).toBe("passed");
    expect(review.session.status).toBe("awaiting_user_accept");

    await expect(service2.acceptDelivery(s2.id)).resolves.toMatchObject({
      status: "completed",
      userAccepted: true
    });

    // Persist round-trip
    const reopened = await CourseworkService.open({
      statePath: join(dir2, "coursework.json"),
      now
    });
    const loaded = await reopened.getSession(s2.id);
    expect(loaded.status).toBe("completed");
    expect(loaded.userAccepted).toBe(true);
    expect(loaded.delivery?.zipContentHash).toBeTruthy();

    const diskZip = await readFile(join(dir2, "packages", s2.id, "delivery.zip"));
    expect(diskZip.subarray(0, 2).toString("utf8")).toBe("PK");

    // First package dir from service1
    expect(pack.manifest.projectRunnable).toBe(true);
    void dir;
  });

  it("blocks accept when review has not passed", async () => {
    const { service } = await open();
    let s = await service.createSession({
      title: "X",
      goal: "Y",
      assignmentBrief: BRIEF
    });
    s = await service.extractSpec(s.id);
    s = await service.generatePlan(s.id);
    s = (await service.approvePlan(s.id, { createDag: false })).session;
    await service.buildPackage(s.id);
    await service.runNoMistakesReview(s.id); // will fail — no evidence
    await expect(service.acceptDelivery(s.id)).rejects.toThrow(/review/i);
  });

  it("reject plan returns to spec_extracted", async () => {
    const { service } = await open();
    let s = await service.createSession({
      title: "X",
      goal: "Y",
      assignmentBrief: BRIEF
    });
    s = await service.extractSpec(s.id);
    s = await service.generatePlan(s.id);
    s = await service.rejectPlan(s.id, "need more research");
    expect(s.status).toBe("spec_extracted");
    expect(s.planApproved).toBe(false);
  });

  it("reject delivery reopens execution", async () => {
    const { service } = await open();
    let s = await service.createSession({
      title: "X",
      goal: "Y",
      assignmentBrief: BRIEF
    });
    s = await service.extractSpec(s.id);
    s = await service.generatePlan(s.id);
    s = (await service.approvePlan(s.id, { createDag: false })).session;
    for (const sp of s.spec!.scoringPoints) {
      await service.addEvidence(s.id, {
        kind: "implementation",
        title: sp.title,
        path: `src/${sp.id}.ts`,
        relatedScoringPointIds: [sp.id]
      });
      await service.addEvidence(s.id, {
        kind: "verification",
        title: `t-${sp.id}`,
        relatedScoringPointIds: [sp.id],
        verification: buildVerificationEvidence({
          results: [{ command: ["npm", "test"], exitCode: 0, stdout: "", stderr: "" }],
          stackPrimary: "nodejs"
        })
      });
      await service.addEvidence(s.id, {
        kind: "screenshot",
        title: `s-${sp.id}`,
        path: `shots/${sp.id}.png`,
        relatedScoringPointIds: [sp.id]
      });
    }
    await service.buildPackage(s.id);
    await service.runNoMistakesReview(s.id);
    s = await service.rejectDelivery(s.id, "need better screenshots");
    expect(s.status).toBe("executing");
    expect(s.userAccepted).toBe(false);
  });
});
