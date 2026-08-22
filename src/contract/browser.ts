export const BROWSER_SETTINGS_VERSION = 3 as const;

export type BrowserProfileMode = "ephemeral" | "persistent" | "unsafe";
export type BrowserPermissionLevel = "none" | "read" | "interact" | "advanced";
export type BrowserPersistentDefaultPermission = "ask" | "deny" | "read" | "interact";
export type BrowserPersistentSessionPermission = "inherit" | "ask" | "deny" | "read" | "interact" | "advanced";
export type BrowserAgentAuthorizationDecision = "deny" | "allow-session";
export type BrowserControlState = "user" | "agent" | "waiting-for-approval";
export type BrowserNetworkIsolation = "best-effort" | "strict";
export type BrowserInputModifier = "alt" | "control" | "meta" | "shift";

export type BrowserErrorCode =
  | "BROWSER_DISABLED"
  | "CAPABILITY_DISABLED"
  | "ADVANCED_BROWSER_MODE_REQUIRED"
  | "ADVANCED_CONFIRMATION_REQUIRED"
  | "CAPABILITY_LEASE_EXPIRED"
  | "POLICY_REVISION_MISMATCH"
  | "USER_DENIED"
  | "AUTHORIZATION_TIMEOUT"
  | "TAB_NOT_FOUND"
  | "TAB_NOT_OWNED"
  | "TAB_CRASHED"
  | "STALE_ELEMENT_REF"
  | "INSPECTION_STALE"
  | "NAVIGATION_BLOCKED"
  | "NAVIGATION_FAILED"
  | "PRIVATE_NETWORK_BLOCKED"
  | "NETWORK_ISOLATION_UNAVAILABLE"
  | "UNSUPPORTED_PROTOCOL"
  | "PERMISSION_DENIED"
  | "USER_TOOK_CONTROL"
  | "ACTION_TIMEOUT"
  | "BROWSER_RETRY_BLOCKED"
  | "BROWSER_ROUTE_BYPASS_BLOCKED"
  | "BROWSER_REPLAN_REQUIRED"
  | "BROWSER_CALL_BUDGET_EXCEEDED"
  | "JAVASCRIPT_TIMEOUT"
  | "JAVASCRIPT_EXECUTION_FAILED"
  | "RESULT_TOO_LARGE"
  | "COOKIE_SCOPE_DENIED"
  | "SENSITIVE_RESULT_UNAVAILABLE"
  | "HEADER_NOT_OVERRIDABLE"
  | "CDP_METHOD_BLOCKED"
  | "REQUEST_REPLAY_NOT_AVAILABLE"
  | "REQUEST_REPLAY_CONFIRMATION_REQUIRED"
  | "REQUEST_REPLAY_EXPIRED"
  | "REQUEST_REPLAY_BLOCKED"
  | "DOWNLOAD_DENIED"
  | "UPLOAD_DENIED"
  | "PROFILE_RECREATE_REQUIRED"
  | "PROFILE_DELETE_RETRY_REQUIRED"
  | "CONSOLE_CURSOR_EXPIRED"
  | "VISUAL_COMPARE_UNAVAILABLE"
  | "INVALID_BROWSER_REQUEST";

export type BrowserRecoveryReason =
  | "policy-denied"
  | "permission-required"
  | "transient-network"
  | "stale-state"
  | "target-closed"
  | "invalid-input"
  | "unsupported";

export type BrowserRecoveryRemediation =
  | "request-authorization"
  | "request-local-network-authorization"
  | "refresh-inspection"
  | "list-owned-tabs"
  | "wait-and-retry-once"
  | "change-input"
  | "ask-user"
  | "none";

export interface BrowserRecovery {
  retryable: boolean;
  reason: BrowserRecoveryReason;
  remediation: BrowserRecoveryRemediation;
  partialTabId?: string;
  retryAfterMs?: number;
}

export interface BrowserStructuredError {
  code: BrowserErrorCode;
  message: string;
  retryable: boolean;
  recovery: BrowserRecovery;
  details?: Record<string, unknown>;
}

export interface BrowserPanelSettings {
  openOnAgentUse: boolean;
  browserWidth: number;
  restoreTabs: boolean;
  defaultProfileId: string;
  saveLoginState: boolean;
}

export interface BrowserNavigationSettings {
  homepage: string;
  maxTabs: number;
  maxTabsPerSession: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  allowHttp: boolean;
  allowPrivateNetwork: boolean;
  networkIsolation: BrowserNetworkIsolation;
}

export interface BrowserAutomationSettings {
  enabled: boolean;
  defaultPermission: BrowserPersistentDefaultPermission;
  sensitiveActions: "always-ask" | "deny";
  userTakeover: "cancel-agent-action" | "wait";
  allowChannelSessions: boolean;
  showActionHighlight: boolean;
}

export interface BrowserDownloadSettings {
  mode: "ask" | "deny" | "allow-to-directory";
  directory?: string;
}

export interface BrowserProxySettings {
  mode: "system" | "direct" | "custom";
  proxyRules?: string;
  proxyBypassRules?: string;
  credentialSecretRef?: string;
}

export interface BrowserAdvancedSettingsV1 {
  enabled: boolean;
  persistence: "this-launch" | "persistent";
  arbitraryJavaScript: boolean;
  cookieAccess: "none" | "current-site" | "all-profile";
  cookieMutation: boolean;
  requestHeaderOverrides: boolean;
  responseHeaderOverrides: boolean;
  customUserAgent: boolean;
  customUserAgentValue: string;
  customUserAgentPlatform: string;
  cdpAllowedMethods: string[];
  allowApprovedChannelSessions: boolean;
}

export interface BrowserSettingsV1 {
  version: 1;
  enabled: boolean;
  panel: BrowserPanelSettings;
  navigation: BrowserNavigationSettings;
  automation: BrowserAutomationSettings;
  downloads: BrowserDownloadSettings;
  proxy: BrowserProxySettings;
  advanced: BrowserAdvancedSettingsV1;
}

export type BrowserIdentityMode = "native" | "chrome-compatible" | "custom";

export interface BrowserAdvancedBrowserModeSettings {
  enabled: boolean;
  persistence: "this-launch";
  identityMode: BrowserIdentityMode;
  customUserAgentValue: string;
  customUserAgentPlatform: string;
  customUserAgentFullVersion: string;
  certificateBypassDomains: string[];
  maxRequestsPerTab: number;
  maxBodyBytesPerTab: number;
  maxPerHost: number;
}

export interface BrowserIdentityProfile {
  mode: BrowserIdentityMode;
  ua: string;
  acceptLanguage: string;
  platform: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
}

export interface BrowserSettingsV3 {
  version: typeof BROWSER_SETTINGS_VERSION;
  enabled: boolean;
  panel: BrowserPanelSettings;
  navigation: BrowserNavigationSettings;
  automation: BrowserAutomationSettings;
  downloads: BrowserDownloadSettings;
  proxy: BrowserProxySettings;
  advancedBrowserMode: BrowserAdvancedBrowserModeSettings;
}

/** Compatibility alias while Phase 8 consumers move to the v3 name. */
export type BrowserSettingsV2 = BrowserSettingsV3;

export interface BrowserSettingsPatch {
  enabled?: boolean;
  panel?: Partial<BrowserPanelSettings>;
  navigation?: Partial<BrowserNavigationSettings>;
  automation?: Partial<BrowserAutomationSettings>;
  downloads?: Partial<BrowserDownloadSettings>;
  proxy?: Partial<BrowserProxySettings>;
  advancedBrowserMode?: Partial<BrowserAdvancedBrowserModeSettings>;
}

/** Main-only runtime policy derived atomically from advancedBrowserMode.enabled. */
export interface BrowserAdvancedRuntimePolicy {
  enabled: boolean;
  removeSiteSecurityHeaders: boolean;
  disableWebSecurity: boolean;
  allowInsecureContent: boolean;
  certificateBypassDomains: string[];
  unrestrictedRawCdp: boolean;
}

export interface BrowserRuntimeAuthorizationPublic {
  policyRevision: number;
  advancedBrowserModeEnabled: boolean;
  advancedTabCount: number;
}

export interface BrowserSettingsPublic {
  settings: BrowserSettingsV2;
  runtime: BrowserRuntimeAuthorizationPublic;
  compatibilityReadOnly: boolean;
}

export type BrowserConfirmationKind = "advanced-browser-mode" | "sensitive-cookies" | "request-replay";

export interface BrowserConfirmationRequest {
  kind: BrowserConfirmationKind;
  settingsPatch?: BrowserSettingsPatch;
  phrase?: string;
}

export interface BrowserConfirmationProof {
  id: string;
  kind: BrowserConfirmationKind;
  expiresAt: number;
  digest: string;
}

export interface BrowserProfileInfo {
  id: string;
  name: string;
  mode: BrowserProfileMode;
  persistent: boolean;
  createdAt: string;
  lastUsedAt: string;
  proxyMode: BrowserProxySettings["mode"];
}

export interface BrowserCreateProfileInput {
  name: string;
  mode: BrowserProfileMode;
}

export type BrowserDataType = "cookies" | "cache" | "local-storage" | "indexed-db" | "service-workers" | "all";

export interface BrowserTabInfo {
  id: string;
  ownerSessionId: string | null;
  profileId: string;
  url: string;
  title: string;
  generation: number;
  visible: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  control: BrowserControlState;
  /** True only while an Agent advanced action is executing. */
  advanced: boolean;
  /** True when the tab uses an unsafe Profile and must not be restored. */
  advancedProfile: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export interface BrowserCreateTabInput {
  profileId?: string;
  url?: string;
  ownerSessionId?: string | null;
  activate?: boolean;
}

export interface BrowserBoundsInput {
  tabId: string;
  rect: { x: number; y: number; width: number; height: number };
  scaleFactorVersion?: number;
}

export interface BrowserSessionGrantInput {
  sessionId: string;
  permission: BrowserPermissionLevel;
  source: "local" | "channel";
  expiresInMs?: number;
}

export interface BrowserPersistentSessionGrant {
  sessionId: string;
  permission: Exclude<BrowserPersistentSessionPermission, "inherit">;
  source: "settings";
  updatedAt: number;
}

export interface BrowserRuntimeSessionGrant {
  sessionId: string;
  permission: Exclude<BrowserPermissionLevel, "none">;
  scope: "session";
  source: "user-prompt" | "persistent-policy";
  expiresAt: number;
}

export interface BrowserAgentAuthorizationRequest {
  id: string;
  sessionId: string;
  source: "local" | "channel";
  methodCategory: "read" | "interact" | "advanced";
  minimumPermission: "read" | "interact" | "advanced";
  createdAt: number;
  expiresAt: number;
}

export interface BrowserCapabilityLease {
  id: string;
  sessionId: string;
  permission: BrowserPermissionLevel;
  policyRevision: number;
  expiresAt: number;
}

export interface BrowserCapabilitySnapshot {
  revision: number;
  browserEnabled: boolean;
  automationEnabled: boolean;
  advancedEnabled: boolean;
  sessionPermissions: Record<string, BrowserPermissionLevel>;
  generatedAt: number;
}

export interface BrowserHostRequestContext {
  sessionId: string;
  tabId?: string;
  capabilityLeaseId: string;
  policyRevision: number;
  requestId: string;
}

export interface BrowserSnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  disabled?: boolean;
  focused?: boolean;
  checked?: boolean | "mixed";
  level?: number;
  bounds?: { x: number; y: number; width: number; height: number };
  frameId?: string;
  frameUrl?: string;
}

export interface BrowserPageSnapshot {
  tabId: string;
  snapshotId: string;
  generation: number;
  url: string;
  title: string;
  text: string;
  nodes: BrowserSnapshotNode[];
  truncated: boolean;
  untrustedWebContent: true;
}

export interface BrowserScreenshotResult {
  tabId: string;
  mime: "image/png" | "image/jpeg";
  base64: string;
  width: number;
  height: number;
  mode: BrowserScreenshotMode;
  generation: number;
  untrustedWebContent: true;
}

export type BrowserScreenshotMode = "viewport" | "full-page" | "element";

export interface BrowserScreenshotOptions {
  mode?: BrowserScreenshotMode;
  format?: "png" | "jpeg";
  quality?: number;
  snapshotId?: string;
  ref?: string;
  generation?: number;
}

export interface BrowserTabSummary {
  id: string;
  profileId: string;
  url: string;
  title: string;
  generation: number;
  loading: boolean;
  crashed: boolean;
  visible: boolean;
}

export interface BrowserInspectResult {
  inspectionId: string;
  tabId: string;
  generation: number;
  tabs: BrowserTabSummary[];
  url: string;
  title: string;
  loading: boolean;
  changed: boolean;
  snapshot?: BrowserPageSnapshot;
  screenshot?: BrowserScreenshotResult;
  truncated: {
    text: boolean;
    nodes: boolean;
    screenshot: boolean;
    tabs: boolean;
  };
  untrustedWebContent: true;
}

export type BrowserConsoleLevel = "error" | "warning" | "info" | "debug";

export interface BrowserConsoleEntry {
  id: string;
  sequence: number;
  level: BrowserConsoleLevel;
  text: string;
  source: string;
  line?: number;
  column?: number;
  stack?: string;
  timestamp: number;
  untrustedWebContent: true;
}

export interface BrowserConsolePage {
  entries: BrowserConsoleEntry[];
  nextCursor?: string;
  truncated: boolean;
  untrustedWebContent: true;
}

export interface BrowserNetworkSummaryRequest {
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failed?: string;
}

export interface BrowserNetworkSummary {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  byResourceType: Record<string, number>;
  byStatusClass: Record<string, number>;
  failures: BrowserNetworkSummaryRequest[];
  recent: BrowserNetworkSummaryRequest[];
  untrustedWebContent: true;
}

export interface BrowserVisualCompareTarget {
  tabId: string;
  snapshotId?: string;
  ref?: string;
  generation?: number;
}

export interface BrowserVisualDifferenceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserVisualCompareResult {
  mode: BrowserScreenshotMode;
  width: number;
  height: number;
  dimensionsMatch: boolean;
  differentPixels: number;
  totalPixels: number;
  differenceRatio: number;
  regions: BrowserVisualDifferenceRegion[];
  leftGeneration: number;
  rightGeneration: number;
  diff?: BrowserScreenshotResult;
  untrustedWebContent: true;
}

export interface BrowserLoadFailure {
  errorCode?: number;
  errorDescription: string;
  url: string;
}

export interface BrowserClickNavigationResult {
  kind: "same-tab" | "new-tab";
  status: "completed" | "failed";
  tabId?: string;
  url: string;
  generation?: number;
  error?: BrowserLoadFailure;
}

export interface BrowserClickResult {
  ok: true;
  action: "clicked" | "external-protocol";
  tabId: string;
  url: string;
  generation: number;
  navigation?: BrowserClickNavigationResult;
}

export interface BrowserNetworkRequest {
  requestId: string;
  sequence: number;
  tabId: string;
  method: string;
  url: string;
  origin: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  encodedDataLength?: number;
  startedAt: number;
  completedAt?: number;
  failed?: string;
  bodyAvailable: boolean;
  bodyTruncated: boolean;
  replayable: boolean;
  replayedFrom?: string;
  untrustedWebContent: true;
}

export interface BrowserNetworkPage {
  requests: BrowserNetworkRequest[];
  nextCursor?: string;
  truncated: boolean;
  untrustedWebContent: true;
}

export interface BrowserNetworkBodyResult {
  requestId: string;
  mimeType: string;
  encoding: "utf8" | "base64";
  data: string;
  offset: number;
  returnedBytes: number;
  totalBytes: number;
  truncated: boolean;
  source: "captured" | "cdp" | "session-refetch" | "replay";
  untrustedWebContent: true;
}

export interface BrowserNetworkReplayResult {
  request: BrowserNetworkRequest;
  responseBody?: BrowserNetworkBodyResult;
}

export interface BrowserPageSnippetSummary {
  id: string;
  enabled: boolean;
  host: string;
  pathPattern: string;
  label: string;
  resultPreview?: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
  codeBytes: number;
  untrustedWebContent: true;
}

export interface BrowserPageSnippet extends BrowserPageSnippetSummary {
  code: string;
}

export interface BrowserPageSnippetPage {
  snippets: BrowserPageSnippetSummary[];
  siteCount: number;
  untrustedWebContent: true;
}

export interface BrowserCookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  session: boolean;
}

export interface BrowserCookiePage {
  cookies: BrowserCookieRecord[];
  nextCursor?: string;
  sensitive: true;
}

export interface BrowserHeaderRule {
  id: string;
  enabled: boolean;
  profileId: string;
  urlPattern: string;
  resourceTypes?: string[];
  header: string;
  operation: "set" | "remove" | "append";
  value?: string;
  secretRef?: string;
  source?: "local" | "agent";
  ownerSessionId?: string;
}

export interface BrowserProxyCredentialsInput {
  username: string;
  password: string;
}

export type BrowserHeaderRuleDirection = "request" | "response";

export interface BrowserDownloadInfo {
  id: string;
  tabId?: string;
  sessionId?: string;
  url: string;
  filename: string;
  state: "pending" | "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  savePath?: string;
  error?: string;
}

export interface BrowserPermissionRequest {
  id: string;
  tabId: string;
  profileId: string;
  origin: string;
  permission: string;
  userGesture: boolean;
  expiresAt: number;
}

export type BrowserPermissionDecision = "allow-once" | "allow-session" | "deny";

export interface BrowserDiagnostics {
  electronVersion: string;
  chromiumVersion: string;
  activeTabCount: number;
  activeProfileCount: number;
  profilePartitions: Array<{ profileId: string; mode: BrowserProfileMode; partition: string }>;
  rendererProcessCount: number;
  rendererWorkingSetBytes: number;
  crashedTabCount: number;
  attachedDebuggerCount: number;
  networkIsolation: BrowserNetworkIsolation;
  networkIsolationSummary: string;
  workflowGuardScope: "obvious-workflow-bypass-only";
  advancedCapabilities: string[];
  advancedTabCount: number;
  capturedRequestCount: number;
  snippetCount: number;
}

export interface BrowserRendererState {
  settings: BrowserSettingsPublic;
  capabilities: BrowserCapabilitySnapshot;
  tabs: BrowserTabInfo[];
  profiles: BrowserProfileInfo[];
  activeTabId: string | null;
  surfaceVisible: boolean;
  downloads: BrowserDownloadInfo[];
  permissionRequests: BrowserPermissionRequest[];
  persistentSessionPermissions: Record<string, Exclude<BrowserPersistentSessionPermission, "inherit">>;
  runtimeSessionGrants: Record<string, BrowserRuntimeSessionGrant>;
  diagnostics: BrowserDiagnostics;
}

export interface BrowserRestoreTabRecord {
  profileId: string;
  url: string;
  ownerSessionId: string | null;
  order: number;
}

export type BrowserEvent =
  | { type: "tab-created"; tab: BrowserTabInfo }
  | { type: "tab-updated"; tab: BrowserTabInfo }
  | { type: "tab-closed"; tabId: string }
  | { type: "active-tab-changed"; tabId: string | null }
  | { type: "permission-request"; request: BrowserPermissionRequest }
  | { type: "permission-resolved"; requestId: string }
  | { type: "agent-authorization-request"; request: BrowserAgentAuthorizationRequest }
  | {
      type: "agent-authorization-resolved";
      requestId: string;
      outcome: "denied" | "allowed-session" | "persistent-policy" | "timeout" | "cancelled";
    }
  | { type: "download"; download: BrowserDownloadInfo }
  | { type: "agent-action"; tabId: string; state: "started" | "finished" | "failed" }
  | { type: "policy-changed"; revision: number; snapshot: BrowserCapabilitySnapshot }
  | { type: "render-process-gone"; tabId: string; reason: string };

export interface BrowserHostRpc {
  "browser.capabilities": {
    params: { sessionId: string };
    result: { snapshot: BrowserCapabilitySnapshot; lease?: BrowserCapabilityLease };
  };
  "browser.requestAuthorization": {
    params: {
      sessionId: string;
      source: "local" | "channel";
      targetMethod: string;
      requestId: string;
    };
    result: { snapshot: BrowserCapabilitySnapshot; lease: BrowserCapabilityLease };
  };
  "browser.sessionEnded": {
    params: { sessionId: string };
    result: { ok: true };
  };
  "browser.requestRouteBypass": {
    params: { sessionId: string; origin: string; ruleId: string; requestId: string };
    result: { allowed: boolean };
  };
  "browser.open": {
    params: BrowserHostRequestContext & { url: string; profileId?: string; activate?: boolean };
    result: BrowserTabInfo & { siteSnippetCount: number };
  };
  "browser.listTabs": {
    params: BrowserHostRequestContext;
    result: { tabs: BrowserTabInfo[] };
  };
  "browser.navigate": {
    params: BrowserHostRequestContext & { tabId: string; url: string };
    result: BrowserTabInfo;
  };
  "browser.snapshot": {
    params: BrowserHostRequestContext & { tabId: string; maxNodes?: number; maxTextChars?: number };
    result: BrowserPageSnapshot;
  };
  "browser.inspect": {
    params: BrowserHostRequestContext & {
      tabId?: string;
      sinceInspectionId?: string;
      maxNodes?: number;
      maxTextChars?: number;
      screenshot?: { enabled: boolean; format?: "png" | "jpeg"; quality?: number };
    };
    result: BrowserInspectResult;
  };
  "browser.screenshot": {
    params: BrowserHostRequestContext & { tabId: string } & BrowserScreenshotOptions;
    result: BrowserScreenshotResult;
  };
  "browser.click": {
    params: BrowserHostRequestContext & {
      tabId: string;
      ref: string;
      snapshotId: string;
      generation: number;
      button?: "left" | "middle" | "right";
      clickCount?: 1 | 2;
      modifiers?: BrowserInputModifier[];
    };
    result: BrowserClickResult;
  };
  "browser.clickAt": {
    params: BrowserHostRequestContext & {
      tabId: string;
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      clickCount?: 1 | 2;
      modifiers?: BrowserInputModifier[];
    };
    result: BrowserClickResult;
  };
  "browser.type": {
    params: BrowserHostRequestContext & {
      tabId: string;
      ref: string;
      snapshotId: string;
      generation: number;
      text: string;
      submit?: boolean;
    };
    result: { ok: true; inputPath: "key-events" | "mixed-insert-text" };
  };
  "browser.press": {
    params: BrowserHostRequestContext & { tabId: string; key: string; modifiers?: BrowserInputModifier[] };
    result: { ok: true };
  };
  "browser.scroll": {
    params: BrowserHostRequestContext & {
      tabId: string;
      deltaX?: number;
      deltaY: number;
      x?: number;
      y?: number;
    };
    result: { ok: true };
  };
  "browser.wait": {
    params: BrowserHostRequestContext & {
      tabId: string;
      timeoutMs?: number;
      condition?: "load" | "network-idle" | "selector" | "text";
      value?: string;
    };
    result: { ok: true; elapsedMs: number };
  };
  "browser.back": { params: BrowserHostRequestContext & { tabId: string }; result: BrowserTabInfo };
  "browser.forward": { params: BrowserHostRequestContext & { tabId: string }; result: BrowserTabInfo };
  "browser.reload": { params: BrowserHostRequestContext & { tabId: string }; result: BrowserTabInfo };
  "browser.close": { params: BrowserHostRequestContext & { tabId: string }; result: { ok: true } };
  "browser.executeJavaScript": {
    params: BrowserHostRequestContext & {
      tabId: string;
      source: string;
      awaitPromise?: boolean;
      returnByValue?: boolean;
      timeoutMs?: number;
      world?: "main" | "isolated";
      purpose?: string;
      remember?: boolean;
    };
    result: { value?: unknown; exception?: string; snippetId?: string; untrustedWebContent: true };
  };
  "browser.getCookies": {
    params: BrowserHostRequestContext & {
      profileId: string;
      scope: "current-site" | "all-profile";
      cursor?: string;
      pageSize?: number;
      confirmationProof?: BrowserConfirmationProof;
    };
    result: BrowserCookiePage;
  };
  "browser.setCookies": {
    params: BrowserHostRequestContext & { profileId: string; cookies: BrowserCookieRecord[] };
    result: { ok: true };
  };
  "browser.setRequestHeaderRules": {
    params: BrowserHostRequestContext & { profileId: string; rules: BrowserHeaderRule[] };
    result: { ok: true };
  };
  "browser.setResponseHeaderRules": {
    params: BrowserHostRequestContext & { profileId: string; rules: BrowserHeaderRule[] };
    result: { ok: true };
  };
  "browser.sendCdpCommand": {
    params: BrowserHostRequestContext & { tabId: string; method: string; commandParams?: Record<string, unknown> };
    result: unknown;
  };
  "browser.networkList": {
    params: BrowserHostRequestContext & {
      tabId: string;
      after?: string;
      resourceTypes?: string[];
      urlPattern?: string;
      status?: number;
      limit?: number;
    };
    result: BrowserNetworkPage;
  };
  "browser.networkWait": {
    params: BrowserHostRequestContext & {
      tabId: string;
      urlPattern?: string;
      resourceType?: string;
      timeoutMs?: number;
    };
    result: BrowserNetworkRequest;
  };
  "browser.networkBody": {
    params: BrowserHostRequestContext & {
      tabId: string;
      networkRequestId: string;
      full?: boolean;
      offset?: number;
      maxBytes?: number;
    };
    result: BrowserNetworkBodyResult;
  };
  "browser.networkReplay": {
    params: BrowserHostRequestContext & {
      tabId: string;
      networkRequestId: string;
      overrides?: { url?: string; headers?: Record<string, string>; body?: string };
      reason: string;
    };
    result: BrowserNetworkReplayResult;
  };
  "browser.networkSummary": {
    params: BrowserHostRequestContext & { tabId: string; failureLimit?: number; recentLimit?: number };
    result: BrowserNetworkSummary;
  };
  "browser.consoleList": {
    params: BrowserHostRequestContext & {
      tabId: string;
      after?: string;
      levels?: BrowserConsoleLevel[];
      limit?: number;
    };
    result: BrowserConsolePage;
  };
  "browser.consoleWait": {
    params: BrowserHostRequestContext & {
      tabId: string;
      after?: string;
      levels?: BrowserConsoleLevel[];
      timeoutMs?: number;
    };
    result: BrowserConsoleEntry;
  };
  "browser.visualCompare": {
    params: BrowserHostRequestContext & {
      left: BrowserVisualCompareTarget;
      right: BrowserVisualCompareTarget;
      mode?: BrowserScreenshotMode;
      threshold?: number;
      includeDiff?: boolean;
    };
    result: BrowserVisualCompareResult;
  };
  "browser.pageCodeList": {
    params: BrowserHostRequestContext & { tabId: string; limit?: number };
    result: BrowserPageSnippetPage;
  };
  "browser.pageCodeGet": {
    params: BrowserHostRequestContext & { tabId: string; snippetId: string; offset?: number; maxChars?: number };
    result: BrowserPageSnippet;
  };
}

export type BrowserHostMethod = keyof BrowserHostRpc;
export type BrowserHostParams<M extends BrowserHostMethod> = BrowserHostRpc[M]["params"];
export type BrowserHostResult<M extends BrowserHostMethod> = BrowserHostRpc[M]["result"];

type BrowserInternalMethod =
  "browser.capabilities" | "browser.requestAuthorization" | "browser.sessionEnded" | "browser.requestRouteBypass";

export type BrowserAutomationMethod = Exclude<BrowserHostMethod, BrowserInternalMethod>;

export type BrowserCommandMetadata =
  | Readonly<{ availability: "internal"; permission: "none"; screenshotCost: 0 }>
  | Readonly<{
      availability: "agent";
      permission: Exclude<BrowserPermissionLevel, "none">;
      screenshotCost: 0 | 1 | 2 | "inspect-optional";
    }>;

export const BROWSER_COMMAND_METADATA = {
  "browser.capabilities": { availability: "internal", permission: "none", screenshotCost: 0 },
  "browser.requestAuthorization": { availability: "internal", permission: "none", screenshotCost: 0 },
  "browser.sessionEnded": { availability: "internal", permission: "none", screenshotCost: 0 },
  "browser.requestRouteBypass": { availability: "internal", permission: "none", screenshotCost: 0 },
  "browser.open": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.listTabs": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.navigate": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.snapshot": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.inspect": { availability: "agent", permission: "read", screenshotCost: "inspect-optional" },
  "browser.screenshot": { availability: "agent", permission: "read", screenshotCost: 1 },
  "browser.click": { availability: "agent", permission: "interact", screenshotCost: 0 },
  "browser.clickAt": { availability: "agent", permission: "interact", screenshotCost: 0 },
  "browser.type": { availability: "agent", permission: "interact", screenshotCost: 0 },
  "browser.press": { availability: "agent", permission: "interact", screenshotCost: 0 },
  "browser.scroll": { availability: "agent", permission: "interact", screenshotCost: 0 },
  "browser.wait": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.back": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.forward": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.reload": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.close": { availability: "agent", permission: "read", screenshotCost: 0 },
  "browser.executeJavaScript": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.getCookies": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.setCookies": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.setRequestHeaderRules": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.setResponseHeaderRules": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.sendCdpCommand": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.networkList": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.networkWait": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.networkBody": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.networkReplay": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.networkSummary": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.consoleList": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.consoleWait": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.visualCompare": { availability: "agent", permission: "read", screenshotCost: 2 },
  "browser.pageCodeList": { availability: "agent", permission: "advanced", screenshotCost: 0 },
  "browser.pageCodeGet": { availability: "agent", permission: "advanced", screenshotCost: 0 },
} as const satisfies Record<BrowserHostMethod, BrowserCommandMetadata>;

export const BROWSER_HOST_METHODS: ReadonlySet<BrowserHostMethod> = new Set(
  Object.keys(BROWSER_COMMAND_METADATA) as BrowserHostMethod[],
);

export function isBrowserHostMethod(method: string): method is BrowserHostMethod {
  return BROWSER_HOST_METHODS.has(method as BrowserHostMethod);
}

export function isBrowserAutomationMethod(method: string): method is BrowserAutomationMethod {
  return isBrowserHostMethod(method) && BROWSER_COMMAND_METADATA[method].availability === "agent";
}

export function browserPermissionForMethod(method: BrowserAutomationMethod): Exclude<BrowserPermissionLevel, "none">;
export function browserPermissionForMethod(method: BrowserHostMethod): BrowserPermissionLevel;
export function browserPermissionForMethod(method: BrowserHostMethod): BrowserPermissionLevel {
  return BROWSER_COMMAND_METADATA[method].permission;
}

export function browserScreenshotCost(method: BrowserHostMethod, params: unknown): number {
  const configuredCost = BROWSER_COMMAND_METADATA[method].screenshotCost;
  if (configuredCost !== "inspect-optional") return configuredCost;
  if (!params || typeof params !== "object" || Array.isArray(params)) return 0;
  const screenshot = (params as { screenshot?: unknown }).screenshot;
  if (!screenshot || typeof screenshot !== "object" || Array.isArray(screenshot)) return 0;
  return (screenshot as { enabled?: unknown }).enabled === true ? 1 : 0;
}
