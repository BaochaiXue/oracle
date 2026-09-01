export const ORACLE_V2_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

export function assertOracleV2ObjectBodySize(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength <= ORACLE_V2_MAX_REQUEST_BODY_BYTES) return;
  throw new Error(
    `${label} is ${bytes.byteLength} bytes, exceeding the Oracle v2 worker request limit of ${ORACLE_V2_MAX_REQUEST_BODY_BYTES} bytes`,
  );
}
