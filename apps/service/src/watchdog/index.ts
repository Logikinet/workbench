export {
  DEFAULT_LAUNCHER_STATE,
  DEFAULT_RESTART_POLICY,
  WATCHDOG_OPERATION_CONTRACT,
  type BundleActivationResult,
  type BundleHealthyResult,
  type BundleManifest,
  type BundleRollbackResult,
  type LauncherState,
  type MigrationBackupManifest,
  type MigrationResult,
  type ReleaseChannel,
  type RuntimeProcessExitInfo,
  type UpdateManifest,
  type UpdateProgress,
  type UpdateSnapshot,
  type UpdateStatus,
  type WatchdogOperationContract,
  type WatchdogProcessState,
  type WatchdogRecoveryState,
  type WatchdogRestartPolicy,
  type WatchdogRuntimeSnapshot
} from "./watchdogTypes.js";

export {
  canAttemptRestart,
  computeRuntimeRestartDelayMs,
  nextRestartAttempt
} from "./restartPolicy.js";

export {
  assertSha256Match,
  normalizeHexHash,
  serializeUnsignedUpdateManifest,
  sha256Hex,
  signEd25519,
  signHmacSha256,
  verifyEd25519,
  verifyHmacSha256,
  verifySignature,
  type SignatureAlgorithm,
  type VerifySignatureOptions
} from "./integrity.js";

export {
  compareSemverLike,
  isLauncherCompatible,
  parseBundleManifest,
  parseUpdateManifest,
  verifyBundlePayload,
  verifyUpdateManifestSignature
} from "./manifests.js";

export {
  LauncherStateStore,
  normalizeLauncherState,
  type LauncherStateFs
} from "./launcherState.js";

export {
  BundleLifecycleService,
  resolveRollbackVersion,
  type BundleLayout
} from "./bundleLifecycle.js";

export {
  DataMigrationService,
  assertWorkbenchOnlyPaths,
  type DataMigrationOptions,
  type MigrationContext,
  type MigrationFs,
  type MigrationStep
} from "./dataMigration.js";

export {
  RuntimeWatchdog,
  type HealthProbeResult,
  type ManagedRuntimeHandle,
  type RuntimeProcessController,
  type RuntimeWatchdogEvent,
  type RuntimeWatchdogOptions
} from "./runtimeWatchdog.js";

export {
  UpdateCoordinator,
  type BundleInstallStore,
  type UpdateCoordinatorOptions,
  type UpdateFetchResponse
} from "./updateCoordinator.js";

export { WatchdogService, type WatchdogServiceOptions } from "./watchdogService.js";

export {
  createWatchdogRouteApp,
  createWatchdogRouter,
  type WatchdogRouteDeps
} from "./watchdogRoutes.js";
