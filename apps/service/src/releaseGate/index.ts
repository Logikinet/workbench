export {
  releaseGateCheckIds,
  RELEASE_GATE_ENVIRONMENT_RISKS,
  releaseGateOk,
  summarizeChecks,
  type EnvironmentRisk,
  type ReleaseGateCategory,
  type ReleaseGateCheck,
  type ReleaseGateCheckId,
  type ReleaseGateCheckStatus,
  type ReleaseGateReport,
  type ReleaseGateSummary
} from "./releaseGateTypes.js";

export {
  REQUIRED_WINDOWS_PACKAGING_SCRIPTS,
  checkInstallScriptsPresent,
  checkUninstallPreservesData,
  loadPlanUninstall,
  packagingWindowsDir,
  resolveRepoRoot,
  type PackagingGateOptions,
  type PlanUninstallLike
} from "./packagingGate.js";

export {
  MemoryCredentialVault,
  checkCredentialVaultRedaction,
  type CredentialVaultGateOptions
} from "./credentialVaultGate.js";

export { checkFakeProviderPlanAndExecute } from "./fakeProviderGate.js";

export {
  DEFAULT_REPORT_JSON_RELATIVE_PATH,
  DEFAULT_REPORT_RELATIVE_PATH,
  buildReport,
  formatAcceptanceReportMarkdown,
  writeAcceptanceReport,
  type WriteReportOptions
} from "./reportWriter.js";

export {
  runReleaseGate,
  type ReleaseGateRunnerOptions,
  type ReleaseGateRunnerResult
} from "./releaseGateRunner.js";
