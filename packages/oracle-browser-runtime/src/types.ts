import type { BrowserContext, Page } from "playwright-core";

export const ORACLE_BROWSER_RUNTIME_ID = "managed-chrome-for-testing-direct-cdp" as const;

export type RuntimeAvailability = "available" | "unavailable";

export interface OracleBrowserRuntimeInspection {
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  label: "Managed Chrome for Testing over direct CDP";
  availability: RuntimeAvailability;
  processOwner: "oracle-worker";
  transport: "direct-cdp";
  executablePath?: string;
  automaticFallback: false;
  reason: string;
}

export interface RuntimeInspectionOptions {
  chromeForTestingExecutablePath?: string;
  executableExists?: (candidate: string) => boolean;
}

export interface ManagedBrowserLaunchInput {
  executablePath: string;
  profileDir: string;
  headless: boolean;
  preserveWindowNames?: readonly string[];
}

export interface LaunchedManagedBrowser {
  context: BrowserContext;
  browserVersion: string;
  executablePath: string;
  restoredPageCount: number;
  openPage(url: string): Promise<Page>;
  close(): Promise<void>;
}

export type LaunchManagedBrowser = (
  input: ManagedBrowserLaunchInput,
) => Promise<LaunchedManagedBrowser>;

export interface RuntimeLaunchReceipt {
  schemaVersion: "oracle.browser-runtime-launch.v2";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  browserRuntimeId: string;
  processOwner: "oracle-worker";
  transport: "direct-cdp";
  profileDir: string;
  executablePath: string;
  browserVersion: string;
  restoredPageCount: number;
  restartOrdinal: number;
  automaticFallback: false;
  launchedAt: string;
  closedAt?: string;
}

export interface OracleBrowserRuntime {
  context: BrowserContext;
  receipt: RuntimeLaunchReceipt;
  openPage(url: string): Promise<Page>;
  close(): Promise<void>;
}

export const RUNTIME_ACCEPTANCE_CHECKS = [
  "login",
  "coldRestart",
  "modelAndEffortControls",
  "fileUpload",
  "playwrightClickWithoutOsFocus",
  "dailyChromeUnaffected",
  "backgroundHeadfulStability",
  "noRecurringDebugApproval",
] as const;

export type RuntimeAcceptanceCheck = (typeof RUNTIME_ACCEPTANCE_CHECKS)[number];
export type RuntimeAcceptanceResult = "pass" | "fail" | "blocked";

export interface RuntimeAcceptanceReceipt {
  schemaVersion: "oracle.browser-runtime-acceptance.v2";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  profileDir: string;
  browserRuntimeId: string;
  restartOrdinal: number;
  checks: Record<RuntimeAcceptanceCheck, RuntimeAcceptanceResult>;
  observedBy: "owner";
  observedAt: string;
  notes?: string;
}

export interface RuntimeCertificationReceipt {
  schemaVersion: "oracle.browser-runtime-certification.v2";
  runtimeId: typeof ORACLE_BROWSER_RUNTIME_ID;
  browserRuntimeId: string;
  processOwner: "oracle-worker";
  transport: "direct-cdp";
  profileDir: string;
  executablePath: string;
  automaticFallback: false;
  acceptance: RuntimeAcceptanceReceipt;
  certifiedAt: string;
}
