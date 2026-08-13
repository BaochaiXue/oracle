import type { BrowserAutomationConfig } from "./types.js";

type BrowserControlConfig = Pick<
  BrowserAutomationConfig,
  | "transport"
  | "attachRunning"
  | "browserTabRef"
  | "remoteChrome"
  | "headless"
  | "hideWindow"
  | "useMockKeychain"
  | "keepBrowser"
  | "manualLogin"
>;

export interface BrowserControlPlan {
  mode:
    | "opencli"
    | "attach-running"
    | "remote-chrome"
    | "headless"
    | "hidden-window"
    | "visible-window";
  launchesChrome: boolean;
  mayFocusWindow: boolean;
  summary: string;
  guidance: string[];
}

export function describeBrowserControlPlan(config: BrowserControlConfig = {}): BrowserControlPlan {
  const guidance: string[] = [];
  const tabRef = String(config.browserTabRef ?? "").trim();
  const reusesExistingTab = tabRef.length > 0;

  if (config.transport === "opencli") {
    guidance.push(
      "OpenCLI is the optional Browser Bridge transport; it does not use Oracle's isolated CDP profile.",
    );
    guidance.push("OpenCLI owns ephemeral tab leases and closes them after each command.");
    guidance.push(
      "Browser Bridge controls its own window/tab presentation, so a Chrome window may become visible or focused.",
    );
    return {
      mode: "opencli",
      launchesChrome: false,
      mayFocusWindow: true,
      summary: "use OpenCLI Browser Bridge",
      guidance,
    };
  }

  if (config.attachRunning) {
    guidance.push(
      reusesExistingTab
        ? `Oracle reuses the matching ChatGPT tab (${tabRef}) and leaves the existing browser process alone.`
        : "Oracle opens a dedicated tab and leaves the existing browser process alone.",
    );
    if (config.keepBrowser) {
      guidance.push("The browser stays open because Oracle did not launch it.");
    }
    return {
      mode: "attach-running",
      launchesChrome: false,
      mayFocusWindow: true,
      summary: reusesExistingTab
        ? "attach to an already-running local Chrome tab"
        : "attach to an already-running local Chrome session",
      guidance,
    };
  }

  if (config.remoteChrome) {
    guidance.push(
      reusesExistingTab
        ? `Oracle reuses the matching ChatGPT tab (${tabRef}) in the configured remote Chrome session.`
        : "Oracle opens a dedicated tab in the configured remote Chrome session.",
    );
    guidance.push("Local Chrome launch, cookie copy, and window hiding flags are skipped.");
    return {
      mode: "remote-chrome",
      launchesChrome: false,
      mayFocusWindow: false,
      summary: reusesExistingTab
        ? "reuse an existing remote Chrome tab"
        : "reuse an existing remote Chrome session",
      guidance,
    };
  }

  if (config.headless) {
    guidance.push("Headless mode avoids visible UI but may be blocked by ChatGPT or Cloudflare.");
    appendKeychainGuidance(guidance, config);
    return {
      mode: "headless",
      launchesChrome: true,
      mayFocusWindow: false,
      summary: "launch headless Chrome",
      guidance,
    };
  }

  if (config.hideWindow) {
    guidance.push(
      "Oracle is using the explicit macOS off-screen policy; the page remains rendered but is not a practical human recovery surface.",
    );
    guidance.push(
      "The first-time `oracle browser setup` flow is intentionally visible; ordinary runs follow this hidden-window policy.",
    );
    appendKeychainGuidance(guidance, config);
    return {
      mode: "hidden-window",
      launchesChrome: true,
      mayFocusWindow: true,
      summary: "launch Chrome in hidden-window mode",
      guidance,
    };
  }

  guidance.push(
    config.manualLogin
      ? "Oracle launches its own persistent profile visibly for this run; it does not attach to personal Chrome."
      : "A visible automation Chrome window may take focus while Oracle controls ChatGPT.",
  );
  appendKeychainGuidance(guidance, config);
  guidance.push(
    "Use --browser-hide-window, --browser-attach-running, or --remote-chrome to reduce desktop disruption.",
  );
  if (config.keepBrowser) {
    guidance.push(
      "Chrome will remain open after the run because --browser-keep-browser is enabled.",
    );
  }

  return {
    mode: "visible-window",
    launchesChrome: true,
    mayFocusWindow: true,
    summary: "launch visible Chrome",
    guidance,
  };
}

function appendKeychainGuidance(guidance: string[], config: BrowserControlConfig): void {
  if (config.manualLogin && config.useMockKeychain) {
    guidance.push(
      "The isolated persistent profile uses Chromium's mock keychain on macOS, avoiding recurring password dialogs with weaker at-rest cookie protection.",
    );
  }
}

export function formatBrowserControlPlan(plan: BrowserControlPlan, label = "browser"): string[] {
  const risk = plan.mayFocusWindow
    ? "may focus/control the browser UI"
    : "does not use a visible local browser window";
  return [
    `[${label}] Browser control: ${plan.summary}; ${risk}.`,
    ...plan.guidance.map((entry) => `[${label}] Browser guidance: ${entry}`),
  ];
}
