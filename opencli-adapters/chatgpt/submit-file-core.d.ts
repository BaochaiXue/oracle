export const CONTRACT_VERSION: 2;
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
  contractVersion: 2;
  manifestPath: string;
  files: AdapterFile[];
}

export interface AssistantMarker {
  index?: number;
  markdown: string;
  sha256: string;
}

export function unwrapEvaluateResult(payload: unknown): unknown;
export function assistantMarkerFromRows(rows: unknown): AssistantMarker | null;
export function matchesAssistantBaseline(
  marker: AssistantMarker | null,
  baselineIndex?: number,
  baselineSha256?: string,
): boolean;
export function buildGenerationControlScript(): string;
export function loadSubmissionManifest(manifestPath: string): LoadedSubmissionManifest;
export function mimeTypeForPath(filePath: string): string;
export function buildDataTransferScript(
  files: Array<Pick<AdapterFile, "name" | "mime" | "base64">>,
): string;
export function extractConversationReceipt(
  rawUrl: unknown,
): { conversationId: string; conversationUrl: string } | null;
