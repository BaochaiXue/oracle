export function shouldSuppressCliIntro(args: string[]): boolean {
  const doctorArgIndex = args.indexOf("doctor");
  if (doctorArgIndex >= 0 && args.slice(doctorArgIndex).includes("--json")) return true;

  const docsArgIndex = args.indexOf("docs");
  if (docsArgIndex >= 0 && args[docsArgIndex + 1] === "check") return true;

  if (args[0] === "bridge" && (args[1] === "codex-config" || args[1] === "claude-config")) {
    return true;
  }

  const browserArgIndex = args.indexOf("browser");
  if (browserArgIndex < 0) return false;
  const browserArgs = args.slice(browserArgIndex + 1);
  const browserCommand = browserArgs[0];
  return browserCommand === "status" || browserCommand === "heal" || browserArgs.includes("--json");
}
