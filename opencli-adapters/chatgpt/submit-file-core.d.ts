export const CONTRACT_VERSION: 1;
export const MAX_TOTAL_FILE_BYTES: number;
export const FIXED_COMPOSER_INSTRUCTION: string;

export interface AdapterFile {
  path: string;
  name: string;
  mime: string;
  sizeBytes: number;
  base64: string;
}

export interface LoadedSubmissionManifest {
  contractVersion: 1;
  manifestPath: string;
  files: AdapterFile[];
}

export function unwrapEvaluateResult(payload: unknown): unknown;
export function loadSubmissionManifest(manifestPath: string): LoadedSubmissionManifest;
export function mimeTypeForPath(filePath: string): string;
export function buildDataTransferScript(
  files: Array<Pick<AdapterFile, "name" | "mime" | "base64">>,
): string;
export function extractConversationReceipt(
  rawUrl: unknown,
): { conversationId: string; conversationUrl: string } | null;
