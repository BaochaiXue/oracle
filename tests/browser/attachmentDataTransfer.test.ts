import { describe, expect, test } from "vitest";
import { guessMimeType } from "../../src/browser/actions/attachmentDataTransfer.js";
import { isMediaFile } from "../../src/browser/prompt.js";

describe("guessMimeType", () => {
  test.each([
    ["clip.mp4", "video/mp4"],
    ["clip.m4v", "video/mp4"],
    ["clip.mov", "video/quicktime"],
    ["clip.mkv", "video/matroska"],
    ["clip.webm", "video/webm"],
    ["clip.avi", "video/x-msvideo"],
  ])("maps %s to %s so the DataTransfer retry does not send octet-stream", (name, mime) => {
    expect(guessMimeType(name)).toBe(mime);
  });

  test("gives every video extension routed to raw upload a video/* type", () => {
    for (const ext of [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]) {
      expect(isMediaFile(`x${ext}`)).toBe(true);
      expect(guessMimeType(`x${ext}`)).toMatch(/^video\//);
    }
  });

  test("still falls back to octet-stream for unknown extensions", () => {
    expect(guessMimeType("blob.unknownext")).toBe("application/octet-stream");
  });
});
