#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = path.join(root, "dist", "docs-site");
const failures = [];
const scannerRel = "scripts/check-public-safety.mjs";

const sourceFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((rel) => fs.existsSync(path.join(root, rel)))
  .sort();

const generatedFiles = fs.existsSync(generatedRoot)
  ? walkFiles(generatedRoot).map((file) => relative(file))
  : [];

for (const rel of [...sourceFiles, ...generatedFiles]) {
  if (rel === scannerRel) continue; // This file necessarily names every rejected identity.
  const absolute = path.join(root, rel);
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  scanText(rel, buffer.toString("utf8"));
}

checkRequiredPaths();
checkPackageMetadata();
checkLicense();
checkNotifier();
checkCiGate();
checkPublicDocs();
checkUpstreamLedger();

if (failures.length > 0) {
  console.error(`public safety check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `public safety check passed (${sourceFiles.length} source files, ${generatedFiles.length} generated docs files)`,
);

function scanText(rel, text) {
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    checkRule(rel, lineNumber, line, "inherited domain", /askoracle\.sh/i, historicalOnly);
    checkRule(
      rel,
      lineNumber,
      line,
      "upstream maintainer identity",
      /Peter Steinberger|steipete@gmail\.com|Y5PE65HELJ/i,
      licenseOrHistory,
    );
    checkRule(
      rel,
      lineNumber,
      line,
      "inherited signing or bundle identity",
      /Developer ID Application:\s*Peter Steinberger|com\.steipete\.oracle\.notifier/i,
      historicalOnly,
    );
    checkRule(
      rel,
      lineNumber,
      line,
      "upstream publishing command",
      /\b(?:npm|pnpm)\s+publish\b|\bnpm\s+dist-tag\b|\bgh\s+release\b|\bbrew\s+install\s+steipete\/tap\/oracle\b|\b(?:npx|pnpx)(?:\s+-y)?\s+@steipete\/oracle\b/i,
      historicalOnly,
    );
    checkRule(
      rel,
      lineNumber,
      line,
      "upstream repository identity outside attribution",
      /github\.com\/steipete\/oracle|(?<!@)\bsteipete\/oracle\b/i,
      upstreamAttributionAllowed,
    );
    checkRule(
      rel,
      lineNumber,
      line,
      "upstream package identity outside compatibility attribution",
      /@steipete\/oracle/i,
      upstreamPackageAllowed,
    );
    checkRule(
      rel,
      lineNumber,
      line,
      "upstream Homebrew identity outside distribution appendix",
      /steipete\/tap\/oracle/i,
      upstreamFormulaAllowed,
    );
    checkPrivatePaths(rel, lineNumber, line);
  }
}

function checkRule(rel, lineNumber, line, label, pattern, allow) {
  if (!pattern.test(line) || allow(rel)) return;
  failures.push(`${rel}:${lineNumber}: ${label}`);
}

function historicalOnly(rel) {
  return rel === "CHANGELOG.md";
}

function licenseOrHistory(rel) {
  return rel === "LICENSE" || historicalOnly(rel);
}

function upstreamAttributionAllowed(rel) {
  if (historicalOnly(rel)) return true;
  const source = new Set([
    "README.md",
    "README.en.md",
    "LAUNCH.md",
    "docs/index.md",
    "docs/upstream-parity.md",
  ]);
  if (source.has(rel)) return true;
  return generatedAttributionPage(rel, ["index.html", "upstream-parity.html"]);
}

function upstreamPackageAllowed(rel) {
  if (historicalOnly(rel)) return true;
  const source = new Set([
    "package.json",
    "docs/index.md",
    "docs/install.md",
    "docs/RELEASING.md",
    "src/cli/docsCheck.ts",
  ]);
  if (source.has(rel)) return true;
  return generatedAttributionPage(rel, ["index.html", "install.html", "RELEASING.html"]);
}

function upstreamFormulaAllowed(rel) {
  if (historicalOnly(rel)) return true;
  if (rel === "docs/install.md") return true;
  return generatedAttributionPage(rel, ["install.html"]);
}

function generatedAttributionPage(rel, allowedNames) {
  return rel.startsWith("dist/docs-site/") && allowedNames.includes(path.posix.basename(rel));
}

function checkPrivatePaths(rel, lineNumber, line) {
  const placeholderOwners = new Set([
    "example",
    "me",
    "openclaw",
    "openclaw2",
    "private",
    "public",
    "someone",
    "test",
    "user",
    "you",
  ]);
  const unixPatterns = [/\/Users\/([^/\s"'`<>]+)/g, /\/home\/([^/\s"'`<>]+)/g];
  for (const pattern of unixPatterns) {
    for (const match of line.matchAll(pattern)) {
      const owner = match[1]?.toLowerCase();
      if (owner && !placeholderOwners.has(owner)) {
        failures.push(
          `${rel}:${lineNumber}: machine-private home path owner ${JSON.stringify(owner)}`,
        );
      }
    }
  }
  for (const match of line.matchAll(/\b[A-Za-z]:\\Users\\([^\\\s"'`<>]+)/g)) {
    const owner = match[1]?.toLowerCase();
    if (owner && !placeholderOwners.has(owner)) {
      failures.push(
        `${rel}:${lineNumber}: machine-private Windows home path owner ${JSON.stringify(owner)}`,
      );
    }
  }
  if (/\/(?:Volumes|var\/folders)\//.test(line)) {
    failures.push(`${rel}:${lineNumber}: machine-private volume or temporary path`);
  }
}

function checkRequiredPaths() {
  for (const rel of [
    ".github/workflows/update-homebrew-tap.yml",
    "scripts/release.sh",
    "docs/CNAME",
    "CNAME",
  ]) {
    if (fs.existsSync(path.join(root, rel)))
      failures.push(`${rel}: inherited authority path exists`);
  }
  if (!fs.existsSync(generatedRoot)) failures.push("dist/docs-site: generated docs are missing");
  if (fs.existsSync(path.join(generatedRoot, "CNAME"))) {
    failures.push("dist/docs-site/CNAME: generated inherited domain authority exists");
  }
}

function checkPackageMetadata() {
  const pkg = readJson("package.json");
  if (pkg.name !== "@steipete/oracle") failures.push("package.json: compatibility name changed");
  if (pkg.private !== true) failures.push("package.json: private must be true");
  if (pkg.license !== "MIT") failures.push("package.json: upstream MIT license metadata changed");
  if (pkg.homepage !== "https://github.com/IndelibleVivi/oracle#readme") {
    failures.push("package.json: homepage is not fork-owned");
  }
  if (pkg.repository?.url !== "git+https://github.com/IndelibleVivi/oracle.git") {
    failures.push("package.json: repository is not fork-owned");
  }
}

function checkLicense() {
  const license = readText("LICENSE");
  if (!license.startsWith("MIT License\n")) failures.push("LICENSE: MIT license header changed");
  if (!license.includes("Copyright (c) 2026 Peter Steinberger")) {
    failures.push("LICENSE: upstream attribution is missing or changed");
  }
}

function checkNotifier() {
  const script = readText("vendor/oracle-notifier/build-notifier.sh");
  if (!script.includes("io.github.indeliblevivi.oracle.notifier")) {
    failures.push("notifier: fork-owned bundle identifier is missing");
  }
  if (!script.includes('IDENTITY="${CODESIGN_ID:-}"')) {
    failures.push("notifier: signing is not explicit and unsigned by default");
  }
}

function checkCiGate() {
  const ci = readText(".github/workflows/ci.yml");
  const pages = readText(".github/workflows/pages.yml");
  if (!ci.includes("pnpm run public:check")) failures.push("CI: public:check is missing");
  if (!pages.includes("pnpm run public:check")) {
    failures.push("Pages: public:check is missing before artifact upload");
  }
}

function checkPublicDocs() {
  const install = readText("docs/install.md");
  if (!install.includes("only installation source")) {
    failures.push("docs/install.md: source-only primary installation claim is missing");
  }
  if (!install.includes("Those channels install upstream Oracle, **not this fork**")) {
    failures.push("docs/install.md: upstream-only distribution distinction is missing");
  }
  for (const rel of ["README.md", "README.en.md", "LAUNCH.md", "docs/index.md"]) {
    const text = readText(rel);
    if (!/unsupported automation boundary/i.test(text)) {
      failures.push(`${rel}: conspicuous unsupported automation boundary is missing`);
    }
    if (!/not affiliated|不附属于/i.test(text) || !/authorized|授权/i.test(text)) {
      failures.push(`${rel}: no-affiliation/no-authorization boundary is incomplete`);
    }
    if (!/terms compliance|terms-compliance/i.test(text)) {
      failures.push(`${rel}: terms-compliance non-claim is missing`);
    }
  }
  if (!readText("LAUNCH.md").includes("PUBLIC LAUNCH NOTE · 2026-08-30")) {
    failures.push("LAUNCH.md: launch-note date is not 2026-08-30");
  }

  const generatedIndex = readText("dist/docs-site/index.html");
  const generatedInstall = readText("dist/docs-site/install.html");
  if (!generatedIndex.includes("Unofficial and unsupported by OpenAI")) {
    failures.push("generated docs: global unofficial boundary is missing");
  }
  if (!generatedIndex.includes("git clone https://github.com/IndelibleVivi/oracle.git")) {
    failures.push("generated docs: fork-owned source install hint is missing");
  }
  if (!generatedInstall.includes("not this fork")) {
    failures.push("generated docs: upstream installation ambiguity remains");
  }
}

function checkUpstreamLedger() {
  const ledger = readText("docs/upstream-parity.md");
  const rows = ledger.match(/^\| \[`[0-9a-f]{8}`\]/gm) ?? [];
  if (rows.length !== 28)
    failures.push(`upstream parity: expected 28 commit rows, found ${rows.length}`);
  for (const status of ["adopted", "independently implemented", "not applicable", "pending"]) {
    const statusCell = new RegExp(`\\|\\s*${status.replaceAll(" ", "\\s+")}\\s*\\|`);
    if (!statusCell.test(ledger)) failures.push(`upstream parity: no ${status} classification`);
  }
  if (!ledger.includes("f5b9c8106cf6b826b3d48fc5a0fb19de26ee584b")) {
    failures.push("upstream parity: merge base is missing");
  }
  if (!ledger.includes("bbc1b3b0261d1ac629075d527e4a4a35bcafe370")) {
    failures.push("upstream parity: checked-through commit is missing");
  }
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function readText(rel) {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) {
    failures.push(`${rel}: required file is missing`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

function walkFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(full) : [full];
    })
    .sort();
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
