// Last line of defence on this computer: an answer is sent back only if it
// does not look like it carries private data from this machine.
import os from "node:os";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bblc_[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/**
 * Why ``text`` must not leave this computer, or null when it looks fine.
 * @param {string} text
 * @param {{home?: string, user?: string}} [who]
 */
export function privateDataReason(text, who = {}) {
  if (!text) return null;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return "it looked like a key or password";
  const home = who.home ?? os.homedir();
  if (home && home.length > 3 && text.includes(home)) return "it mentioned a folder on this computer";
  if (/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\]+[/\\]\.(?:ssh|aws|config|gnupg|kube)\b/.test(text)) {
    return "it mentioned a private folder";
  }
  return null;
}
