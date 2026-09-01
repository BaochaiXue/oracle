import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ObjectRef } from "../../oracle-kernel/src/index.js";
import { ObjectIntegrityError } from "./errors.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface PutObjectOptions<T extends ObjectRef["objectClass"] = ObjectRef["objectClass"]> {
  mediaType: string;
  objectClass: T;
  expectedSha256?: string;
}

export type TypedObjectRef<T extends ObjectRef["objectClass"]> = Omit<ObjectRef, "objectClass"> & {
  objectClass: T;
};

export class ContentAddressedStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    ensurePrivateDirectory(rootDir);
  }

  put<T extends ObjectRef["objectClass"]>(
    bytesInput: Uint8Array,
    options: PutObjectOptions<T>,
  ): TypedObjectRef<T> {
    const bytes = Buffer.from(bytesInput);
    const sha256 = digest(bytes);
    if (options.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new ObjectIntegrityError(
        sha256,
        `expected SHA-256 ${options.expectedSha256}, calculated ${sha256}`,
      );
    }
    const ref: TypedObjectRef<T> = {
      sha256,
      sizeBytes: bytes.byteLength,
      mediaType: options.mediaType,
      objectClass: options.objectClass,
    };
    const finalPath = this.pathFor(sha256);
    ensurePrivateDirectory(path.dirname(finalPath));
    if (existsSync(finalPath)) {
      this.read(ref);
      return ref;
    }

    const temporaryPath = path.join(path.dirname(finalPath), `.${sha256}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, finalPath);
      chmodSync(finalPath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
    return ref;
  }

  read(ref: ObjectRef): Buffer {
    const objectPath = this.pathFor(ref.sha256);
    if (!existsSync(objectPath)) {
      throw new ObjectIntegrityError(ref.sha256, "object file is missing");
    }
    const bytes = readFileSync(objectPath);
    if (bytes.byteLength !== ref.sizeBytes) {
      throw new ObjectIntegrityError(
        ref.sha256,
        `expected ${ref.sizeBytes} bytes, read ${bytes.byteLength}`,
      );
    }
    const actual = digest(bytes);
    if (actual !== ref.sha256) {
      throw new ObjectIntegrityError(ref.sha256, `calculated SHA-256 ${actual}`);
    }
    return bytes;
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  delete(sha256: string): void {
    const objectPath = this.pathFor(sha256);
    if (existsSync(objectPath)) unlinkSync(objectPath);
  }

  pathFor(sha256: string): string {
    if (!SHA256_PATTERN.test(sha256)) throw new Error(`Invalid SHA-256 digest: ${sha256}`);
    return path.join(this.rootDir, sha256.slice(0, 2), sha256);
  }
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}
