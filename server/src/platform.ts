/** 平台差异收敛层：业务与特权模块禁止直接读 process.platform。 */
export function isWindows(): boolean {
  return process.platform === "win32";
}

export function normalizePathForCompare(path: string, win = isWindows()): string {
  return win ? path.toLowerCase() : path;
}
