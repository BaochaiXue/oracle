import { describe, expect, test } from "vitest";
import { createSealedSourceBundle } from "../../packages/oracle-bundle/src/index.js";

describe("Oracle v2 sealed source bundle", () => {
  test("is deterministic across input order and normalizes textual newlines", () => {
    const first = createSealedSourceBundle([
      { path: "src/b.ts", bytes: Buffer.from("second\r\n", "utf8") },
      { path: "src/a.ts", bytes: Buffer.from("first\n", "utf8") },
    ]);
    const second = createSealedSourceBundle([
      { path: "src/a.ts", bytes: Buffer.from("first\n", "utf8") },
      { path: "src/b.ts", bytes: Buffer.from("second\n", "utf8") },
    ]);

    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(first.filename).toBe(`oracle-source-${first.artifactSha256.slice(0, 12)}.md`);
    expect(first.bytes.toString("utf8")).toContain(
      `source-set-sha256: ${first.sourceSetSha256}\nfile-count: 2`,
    );
    expect(first.bytes.toString("utf8")).toContain("path: src/a.ts\nsize-bytes: 6\nsha256:");
  });

  test("rejects duplicate, unsafe, or non-text inputs", () => {
    expect(() =>
      createSealedSourceBundle([
        { path: "a.ts", bytes: Buffer.from("one") },
        { path: "a.ts", bytes: Buffer.from("two") },
      ]),
    ).toThrow("Duplicate sealed bundle path");
    for (const unsafePath of ["./a.ts", "a/../b.ts", "dir\\file.ts"]) {
      expect(() =>
        createSealedSourceBundle([{ path: unsafePath, bytes: Buffer.from("unsafe") }]),
      ).toThrow();
    }
    expect(() =>
      createSealedSourceBundle([{ path: "line\nbreak.ts", bytes: Buffer.from("unsafe") }]),
    ).toThrow("unsupported characters");
    expect(() =>
      createSealedSourceBundle([{ path: "../private.txt", bytes: Buffer.from("private") }]),
    ).toThrow("safe relative path");
    expect(() =>
      createSealedSourceBundle([{ path: "binary.dat", bytes: Buffer.from([0xff, 0xfe]) }]),
    ).toThrow("not valid UTF-8 text");
  });

  test("preserves safe path bytes and orders them by UTF-8 bytes", () => {
    const paths = ["ä.ts", "z.ts", " spaced.ts "];
    const bundle = createSealedSourceBundle(
      paths.map((filePath) => ({ path: filePath, bytes: Buffer.from(filePath) })),
    );
    const expected = [...paths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );

    expect(bundle.files.map((file) => file.path)).toEqual(expected);
    expect(bundle.files.some((file) => file.path === " spaced.ts ")).toBe(true);
  });
});
