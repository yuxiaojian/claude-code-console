// What the browser may learn about a Codex failure. Native error text can carry keys,
// tokens and paths, so the browser gets a fixed message per category. The only native
// detail ever passed on (a turn's error message from the model provider, a rollout error
// event) goes through redact() first.

export const MESSAGES = {
  notInstalled: 'Codex CLI is not installed or not on PATH.',
  unsupportedVersion: 'This Codex CLI version has not been tested with the console. Chat for Codex is off.',
  login: 'Codex is not logged in, or its login has expired. Run `codex login` in a terminal.',
  busy: 'This session is open in another Codex process. Fork it to continue here.',
  exited: 'Codex stopped unexpectedly.',
  protocol: 'Codex sent a reply the console does not understand.',
  unsupported: 'Codex asked for something the console does not support.',
  failed: 'Codex reported an error.',
};

/** Thrown to the server with a message that is safe to show as is. */
export class CodexError extends Error {
  constructor(category, detail = '') {
    super(MESSAGES[category] || MESSAGES.failed);
    this.category = category;
    this.detail = detail; // never sent to the browser
  }
}

const RULES = [
  [/\bbearer\s+\S+/gi, 'Bearer [redacted]'],
  // Secret-looking assignments first, so the value goes even when it is short.
  [/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)\b(\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]'],
  [/\b(?:sk|rk|pk|sess|ghp|gho|ghu|ghs|xox[abprs])[-_][A-Za-z0-9_-]{6,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted]'], // JWT
  [/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]'],        // long opaque strings
  [/(?:file:\/\/)?(?:~|[A-Za-z]:)?(?:[\\/][^\s\\/'"`:]+){2,}[\\/]?/g, '[path]'],
];

/** Strip anything that looks like a credential or a file path, then clip. */
export function redact(text, max = 200) {
  let s = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Category for a JSON-RPC error or a turn error from app-server. */
export function categorize(err) {
  const info = err?.codexErrorInfo;
  if (info === 'unauthorized') return 'login';
  const msg = String(err?.message || '');
  if (/already has an active writer|thread-store conflict/i.test(msg)) return 'busy';
  if (/\b(401|unauthori[sz]ed|not logged in|login|api key|authentication)\b/i.test(msg)) return 'login';
  return 'failed';
}

/**
 * The text a run shows for a failed turn: a fixed message, plus the provider's own
 * explanation when it is a model-side condition worth reading (rate limits and the like).
 */
export function turnErrorText(err) {
  const cat = categorize(err);
  if (cat !== 'failed') return MESSAGES[cat];
  const detail = redact(err?.message || '', 160);
  return detail ? `${MESSAGES.failed} ${detail}` : MESSAGES.failed;
}
