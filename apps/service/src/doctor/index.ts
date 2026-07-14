export {
  DEFAULT_BIND_HOST,
  DEFAULT_LOG_LINES,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_SERVICE_PORT,
  DOCTOR_OPERATION_CONTRACT,
  doctorCheckIds,
  MAX_LOG_LINES,
  type DiagnosticPackManifest,
  type DiagnosticPackResult,
  type DoctorCheck,
  type DoctorCheckCategory,
  type DoctorCheckId,
  type DoctorCheckStatus,
  type DoctorCheckSummary,
  type DoctorFixRequest,
  type DoctorOperationContract,
  type DoctorReport,
  type DoctorRunOptions,
  type HealthProbeResult,
  type LogArchiveEntry,
  type LogKind,
  type LogQuery,
  type LogSlice,
  type RuntimeEndpoints,
  type RuntimeHealthLevel,
  type RuntimeProcessInfo,
  type RuntimeStatusReport
} from "./doctorTypes.js";

export {
  appendRedactedLogLine,
  redactLogText,
  defaultHealthProbe,
  defaultPortProbe,
  DoctorService,
  resolveDoctorExitCode,
  resolveHealthLevel,
  summarizeChecks,
  waitForHealth,
  type DoctorCodexStatus,
  type DoctorConnectionView,
  type DoctorFs,
  type DoctorGitResult,
  type DoctorMcpView,
  type DoctorOfficeAvailability,
  type DoctorPortProbe,
  type DoctorRuntimeAdapterView,
  type DoctorServiceOptions,
  type DoctorTrayPresence
} from "./doctorService.js";

export {
  createDoctorRouteApp,
  createDoctorRouter,
  type DoctorRouteDeps
} from "./doctorRoutes.js";
