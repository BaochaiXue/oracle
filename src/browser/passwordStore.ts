const LINUX_BASIC_PASSWORD_STORE_ENV = "ORACLE_BROWSER_LINUX_BASIC_PASSWORD_STORE";

export function useExplicitLinuxBasicPasswordStore(): boolean {
  const value = process.env[LINUX_BASIC_PASSWORD_STORE_ENV]?.trim();
  if (!value) return false;
  if (value !== "1") {
    throw new Error(`${LINUX_BASIC_PASSWORD_STORE_ENV} must be 1 or unset.`);
  }
  if (process.platform !== "linux") {
    throw new Error(`${LINUX_BASIC_PASSWORD_STORE_ENV}=1 is supported only on Linux.`);
  }
  return true;
}
