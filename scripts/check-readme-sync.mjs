#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const files = ["README.md", "README.en.md"];
const sharedHero = "assets/readme/oracle-hero.svg";
const text = Object.fromEntries(
  files.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]),
);

const fail = (message) => {
  console.error(`README sync check failed: ${message}`);
  process.exitCode = 1;
};

const markerIds = (value) =>
  [...value.matchAll(/<!--\s*readme-sync:([a-z0-9-]+)\s*-->/g)].map((match) => match[1]);

const fencedBlocks = (value) =>
  [...value.matchAll(/^```[^\n]*\n[\s\S]*?^```\s*$/gm)].map((match) => match[0]);

const targets = (value) => {
  const markdown = [...value.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
  const html = [...value.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  return [...markdown, ...html]
    .map((target) => target.replace(/^\.\/README(?:\.en)?\.md$/, "<LANG_README>"))
    .sort();
};

const [zh, en] = files;
const zhMarkers = markerIds(text[zh]);
const enMarkers = markerIds(text[en]);
if (JSON.stringify(zhMarkers) !== JSON.stringify(enMarkers)) {
  fail(`section markers differ\n${zh}: ${zhMarkers.join(", ")}\n${en}: ${enMarkers.join(", ")}`);
}

const zhBlocks = fencedBlocks(text[zh]);
const enBlocks = fencedBlocks(text[en]);
if (JSON.stringify(zhBlocks) !== JSON.stringify(enBlocks)) {
  fail("fenced command/config blocks differ");
}

const zhTargets = targets(text[zh]);
const enTargets = targets(text[en]);
if (JSON.stringify(zhTargets) !== JSON.stringify(enTargets)) {
  fail("link or asset targets differ");
}

for (const file of files) {
  if (text[file].includes("README-header.png")) {
    fail(`${file} still references the retired upstream-style header`);
  }
  if (!text[file].includes(sharedHero)) {
    fail(`${file} does not reference the shared Oracle hero`);
  }
}

if (!fs.existsSync(path.join(root, sharedHero))) {
  fail(`shared hero is missing: ${sharedHero}`);
}

if (!process.exitCode) {
  console.log(`README sync check passed: ${zhMarkers.length} mirrored sections.`);
}
