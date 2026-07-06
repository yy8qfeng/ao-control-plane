export function isConditionalReworkTaskText(text: string): boolean {
  return /仅在|only\s+when|approved 路径不派发|pass 路径不派发|回流重规划|rework_request/i.test(text);
}

export function skipsOnApprovedPath(text: string): boolean {
  return /approved 路径不派发|仅在.*(?:非 approved|rework_required|rejected|驳回|失败|不通过)|only when.*(?:not approved|rework|required|rejected|fail)/i.test(text);
}

export function skipsOnPassPath(text: string): boolean {
  return /pass 路径不派发|仅在.*(?:verdict=fail|decision=fail|fail|失败)|only when.*(?:fail|failed)/i.test(text);
}

export function hasConditionalSkipConvention(text: string): boolean {
  return skipsOnApprovedPath(text) || skipsOnPassPath(text);
}
