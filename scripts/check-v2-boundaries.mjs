import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const v2Roots = ["packages", "apps"];
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const violations = [];

function walk(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...walk(relativePath));
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }
  return files;
}

function importSpecifiers(source) {
  const values = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return values;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

for (const relativePath of v2Roots.flatMap(walk)) {
  const absolutePath = path.join(root, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  for (const specifier of importSpecifiers(source)) {
    const normalized = specifier.replaceAll("\\", "/");
    const resolvesToLegacyBrowser =
      normalized === "@src/browser" ||
      normalized.startsWith("@src/browser/") ||
      normalized.includes("/src/browser/") ||
      normalized.endsWith("/src/browser");
    if (resolvesToLegacyBrowser) {
      violations.push(`${relativePath}: imports legacy browser source via ${specifier}`);
    }
  }

  const normalizedPath = relativePath.replaceAll("\\", "/");
  const isAdapter = normalizedPath.startsWith("packages/chatgpt-adapter/");
  const isProviderFixture = normalizedPath.startsWith("apps/oracle-provider-fixture/");
  if (!isAdapter) {
    const pageKnowledgePatterns = [
      { label: "Playwright page evaluation", pattern: /\.evaluate\s*\(/g },
    ];
    if (!isProviderFixture) {
      pageKnowledgePatterns.push({
        label: "ChatGPT selector literal",
        pattern: /(?:data-testid|aria-label)[^\n]{0,120}(?:composer|send|message|model)/gi,
      });
    }
    for (const { label, pattern } of pageKnowledgePatterns) {
      for (const match of source.matchAll(pattern)) {
        violations.push(
          `${relativePath}:${lineNumber(source, match.index)}: ${label} outside chatgpt-adapter`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Oracle v2 boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Oracle v2 boundaries: ok");
}
