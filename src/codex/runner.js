import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile, spawn as childSpawn } from 'node:child_process';
import { CONSOLE_SOURCE } from './store.js';
import { CodexError, MESSAGES, categorize, redact, turnErrorText } from './errors.js';
import { diffHunks } from './transcript.js';

// Runs Codex sessions from the console through `codex app-server` (JSON-RPC over stdio),
// one child process per run. The console only ever writes to threads it started or forked
// itself: there is no resume. Native approval and question requests wait in `approvals`
// until the user answers in the browser; each is answered at most once, and closing a run
// answers nothing, so nothing is ever granted by default.
// Protocol validated live against Codex CLI 0.164.0: initialize, thread/start, thread/fork,
// turn/start, item/commandExecution/requestApproval, serverRequest/resolved, turn/completed.
// File-change, permissions, question and elicitation requests, turn/steer and turn/interrupt
// follow the 0.164.0 JSON schema but were not exercised live.

export const MIN_VERSION = '0.164.0';
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_RUNS = 8;
const RPC_TIMEOUT_MS = 60_000;
const SHOWN_MAX = 4_000;

/**
 * Policy presets the console offers, as native Codex values. Full access and `never` are
 * left out on purpose. Everything else (model, effort, rules, managed constraints) comes
 * from the user's Codex configuration.
 */
export const MODES = {
  workspace: { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  untrusted: { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } },
};
export const DEFAULT_MODE = 'workspace';
/** app-server reports the sandbox in camelCase; show it the way config.toml and the CLI spell it. */
const SANDBOX_NAMES = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access', externalSandbox: 'external-sandbox' };

const clip = (s, n = SHOWN_MAX) => (s.length > n ? s.slice(0, n) + '…' : s);
const str = v => (typeof v === 'string' ? v : '');

function versionAtLeast(v, min) {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

/** Is a usable Codex CLI installed? Never runs anything that touches the login. */
export function detectCodex(command = 'codex') {
  return new Promise(resolve => {
    execFile(command, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve({ installed: false, version: '', chat: false, reason: MESSAGES.notInstalled });
      const version = String(stdout).match(/(\d+\.\d+\.\d+)/)?.[1] || '';
      const ok = version && versionAtLeast(version, MIN_VERSION);
      resolve({ installed: true, version, chat: Boolean(ok), reason: ok ? '' : MESSAGES.unsupportedVersion });
    });
  });
}

const DECISION_LABELS = {
  accept: 'Allow',
  acceptForSession: 'Allow for this session',
  decline: 'Deny',
  cancel: 'Deny and stop the turn',
};

/** The native decisions a command approval offers, with labels; anything unrecognised is left out. */
function commandDecisions(available) {
  const list = Array.isArray(available) ? available : ['accept', 'acceptForSession', 'decline', 'cancel'];
  const out = [];
  list.forEach((d, i) => {
    if (typeof d === 'string' && DECISION_LABELS[d]) out.push({ id: d, label: DECISION_LABELS[d], value: d });
    else if (Array.isArray(d?.acceptWithExecpolicyAmendment?.execpolicy_amendment)) {
      const prefix = d.acceptWithExecpolicyAmendment.execpolicy_amendment.map(String).join(' ');
      out.push({ id: 'execpolicy', label: `Always allow commands starting with “${clip(prefix, 200)}” (saved to your Codex rules)`, value: d, persistent: true });
    } else if (d?.applyNetworkPolicyAmendment?.network_policy_amendment) {
      const a = d.applyNetworkPolicyAmendment.network_policy_amendment;
      out.push({ id: `network${i}`, label: `${a.action === 'deny' ? 'Always block' : 'Always allow'} network access to ${clip(str(a.host), 200)} (saved to your Codex rules)`, value: d, persistent: true });
    }
  });
  return out;
}

const plainDecisions = ids => ids.map(id => ({ id, label: DECISION_LABELS[id], value: id }));

/** File changes as the approval card shows them, from the item app-server announced. */
function fileChanges(item) {
  const changes = item?.changes;
  const list = Array.isArray(changes) ? changes.map(c => [str(c?.path), { unified_diff: str(c?.diff) }])
    : changes && typeof changes === 'object' ? Object.entries(changes) : [];
  return list.filter(([p]) => p).slice(0, 20).map(([p, c]) => ({ path: p, diff: diffHunks(c) }));
}

export class CodexRunner extends EventEmitter {
  /** `spawn` and `command` are injectable so tests run a fake app-server. */
  constructor({ command = 'codex', spawn = childSpawn, available = { chat: false, reason: MESSAGES.notInstalled }, idleMs = IDLE_CLOSE_MS, rpcTimeoutMs = RPC_TIMEOUT_MS } = {}) {
    super();
    this.command = command;
    this.spawn = spawn;
    this.available = available;
    this.idleMs = idleMs;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.runs = new Map();
  }

  get chat() { return Boolean(this.available?.chat); }

  #changed() { this.emit('change'); }

  bySession(sessionId) {
    for (const r of this.runs.values()) if (r.sessionId === sessionId && r.state !== 'closed') return r;
    return null;
  }

  ownedSessions() {
    return new Set([...this.runs.values()].filter(r => r.state !== 'closed' && r.sessionId).map(r => r.sessionId));
  }

  /** Process ids of the console's own app-servers, so their writer locks don't look external. */
  ownPids() {
    return new Set([...this.runs.values()].filter(r => r.state !== 'closed' && r.child?.pid).map(r => r.child.pid));
  }

  /**
   * Start a new thread in `cwd`, or fork thread `fork` into a new one, and send `prompt`.
   * Resolves once Codex accepted the turn; a failed start leaves no run behind.
   */
  async start({ cwd, prompt, fork = null, mode = DEFAULT_MODE, model = null }) {
    if (!this.chat) throw new CodexError(this.available?.installed ? 'unsupportedVersion' : 'notInstalled');
    if (!MODES[mode]) throw new Error('Unknown Codex policy');
    const live = [...this.runs.values()].filter(r => r.state !== 'closed');
    if (live.length >= MAX_RUNS) throw new Error(`Already running ${MAX_RUNS} Codex sessions from the console`);

    const run = {
      key: crypto.randomBytes(8).toString('hex'),
      provider: 'codex',
      sessionId: null,
      forkedFrom: fork,
      cwd,
      mode,
      appliedMode: mode,
      model,
      policy: { approval: MODES[mode].approvalPolicy, sandbox: MODES[mode].sandbox },
      state: 'starting',
      turnId: null,
      approvals: new Map(),
      decisions: new Map(), // approval id -> native values, never sent to the browser
      items: new Map(),     // item id -> item, for file-change approvals
      error: null,
      notice: null,         // a fixed explanation the UI shows, e.g. a policy Codex substituted
      startedAt: Date.now(),
      child: null,
      rpc: null,
      idleTimer: null,
      seq: 0,
    };
    this.#connect(run);
    this.runs.set(run.key, run);
    this.#trim();
    this.#changed();
    try {
      await run.rpc('initialize', { clientInfo: { name: CONSOLE_SOURCE, title: 'Claude Code Console', version: '0.1.0' } });
      run.notify('initialized');
      const policy = { approvalPolicy: MODES[mode].approvalPolicy, sandbox: MODES[mode].sandbox, threadSource: CONSOLE_SOURCE, ...(model ? { model } : {}) };
      const res = fork
        ? await run.rpc('thread/fork', { threadId: fork, ...policy })
        : await run.rpc('thread/start', { cwd, ...policy });
      const id = res?.thread?.id;
      if (typeof id !== 'string' || !id) throw new CodexError('protocol', 'no thread id');
      run.sessionId = id;
      run.model = str(res.model) || model;
      run.policy = {
        approval: typeof res.approvalPolicy === 'string' ? res.approvalPolicy : res.approvalPolicy ? 'granular' : run.policy.approval,
        sandbox: SANDBOX_NAMES[str(res.sandbox?.type)] || str(res.sandbox?.type) || run.policy.sandbox,
      };
      // Managed requirements make Codex fall back to another value rather than fail: say so.
      const want = MODES[mode];
      if (run.policy.approval !== want.approvalPolicy || run.policy.sandbox !== want.sandbox) {
        run.notice = `Codex is using approval ${run.policy.approval} · sandbox ${run.policy.sandbox} instead of ${want.approvalPolicy} · ${want.sandbox}, probably because its managed settings require it.`;
      }
      await this.#turn(run, prompt);
    } catch (err) {
      this.close(run.key); // ends the child too: a failed start must not leave a process (or its writer lock) behind
      this.runs.delete(run.key);
      this.#changed();
      throw err instanceof CodexError ? err : new CodexError(categorize(err), err?.message);
    }
    return run;
  }

  /** JSON-RPC over the child's stdio. */
  #connect(run) {
    const child = this.spawn(this.command, ['app-server'], { cwd: run.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    run.child = child;
    const pending = new Map();
    let nextId = 1;
    let buf = '';
    const write = msg => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch { /* gone */ } };
    run.rpc = (method, params) => new Promise((resolve, reject) => {
      if (run.state === 'closed') return reject(new CodexError('exited'));
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new CodexError('protocol', `${method} timed out`)); }, this.rpcTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
    run.notify = (method, params) => write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    run.reply = (id, result) => write({ jsonrpc: '2.0', id, result });
    run.replyError = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32601, message } });
    run.rejectAll = err => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) !== -1;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; } // not JSON-RPC: ignored
        if (!m || typeof m !== 'object') continue;
        if (m.id != null && typeof m.method === 'string') this.#request(run, m);
        else if (m.id != null && pending.has(m.id)) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) p.reject(Object.assign(new Error(str(m.error.message) || 'error'), { codexErrorInfo: m.error.data?.codexErrorInfo }));
          else p.resolve(m.result);
        } else if (typeof m.method === 'string') this.#notification(run, m.method, m.params || {});
      }
    });
    child.stderr?.on('data', () => {}); // Codex logs there; it can hold paths and secrets, so it's dropped
    child.on('error', err => {
      run.error = err?.code === 'ENOENT' ? MESSAGES.notInstalled : MESSAGES.exited;
      run.rejectAll(new CodexError(err?.code === 'ENOENT' ? 'notInstalled' : 'exited'));
      this.#finish(run);
    });
    child.on('exit', () => {
      if (run.state !== 'closed' && !run.closing) run.error = run.error || MESSAGES.exited;
      run.rejectAll(new CodexError('exited'));
      this.#finish(run);
    });
  }

  async #turn(run, text) {
    clearTimeout(run.idleTimer);
    const input = [{ type: 'text', text, text_elements: [] }];
    try {
      if (run.turnId) {
        // Steering joins the running turn, which keeps its policy. Don't let a message go out
        // under the old policy after the user changed it: they resend once the turn is over.
        if (run.mode !== run.appliedMode) throw new CodexError('policyPending');
        await run.rpc('turn/steer', { threadId: run.sessionId, expectedTurnId: run.turnId, input });
      } else {
        const preset = MODES[run.mode];
        // Policy overrides only when the user changed the mode, so native settings otherwise stand.
        const overrides = run.mode !== run.appliedMode ? { approvalPolicy: preset.approvalPolicy, sandboxPolicy: preset.sandboxPolicy } : {};
        const res = await run.rpc('turn/start', { threadId: run.sessionId, input, ...overrides });
        if (run.mode !== run.appliedMode) {
          run.appliedMode = run.mode;
          // turn/start doesn't echo the effective policy, so this is what was asked for.
          run.policy = { approval: preset.approvalPolicy, sandbox: preset.sandbox, requested: true };
          run.notice = null;
        }
        if (typeof res?.turn?.id === 'string' && res.turn.status === 'inProgress') run.turnId = res.turn.id;
      }
    } catch (err) {
      const cat = err instanceof CodexError ? err.category : categorize(err);
      if (cat === 'busy') this.close(run.key); // another process holds the thread: give up, don't retry
      if (cat === 'policyPending') throw err;
      throw err instanceof CodexError ? err : new CodexError(cat, err?.message);
    }
    run.state = 'running';
    run.error = null;
    this.#changed();
  }

  #notification(run, method, p) {
    switch (method) {
      case 'turn/started':
        if (typeof p.turn?.id === 'string') run.turnId = p.turn.id;
        run.state = 'running';
        break;
      case 'turn/completed': {
        const t = p.turn || {};
        if (run.turnId === t.id || !run.turnId) run.turnId = null;
        if (t.status === 'failed' && t.error) run.error = turnErrorText(t.error);
        for (const [id, a] of run.approvals) if (a.turnId === t.id) { run.approvals.delete(id); run.decisions.delete(id); }
        if (!run.turnId) {
          run.state = 'idle';
          clearTimeout(run.idleTimer);
          run.idleTimer = setTimeout(() => this.close(run.key), this.idleMs);
          run.idleTimer.unref?.();
        }
        break;
      }
      case 'serverRequest/resolved':
        for (const [id, a] of run.approvals) if (a.rpcId === p.requestId) { run.approvals.delete(id); run.decisions.delete(id); }
        break;
      case 'error':
        if (p.willRetry !== true && p.error) run.error = turnErrorText(p.error);
        break;
      case 'item/started':
        if (p.item?.type === 'fileChange' && typeof p.item.id === 'string') {
          run.items.set(p.item.id, p.item);
          if (run.items.size > 50) run.items.delete(run.items.keys().next().value);
        }
        return;
      default:
        return;
    }
    this.#changed();
  }

  /** A request from Codex: an approval or question for the browser, or a polite refusal. */
  #request(run, m) {
    const p = m.params && typeof m.params === 'object' ? m.params : {};
    const a = { id: `r${++run.seq}`, rpcId: m.id, turnId: str(p.turnId), at: Date.now(), reason: clip(str(p.reason), 2000) };
    switch (m.method) {
      case 'item/commandExecution/requestApproval':
        Object.assign(a, { kind: 'command', command: clip(str(p.command)), cwd: str(p.cwd), decisions: commandDecisions(p.availableDecisions) });
        break;
      case 'item/fileChange/requestApproval':
        Object.assign(a, { kind: 'fileChange', files: fileChanges(run.items.get(p.itemId)), grantRoot: str(p.grantRoot),
          decisions: plainDecisions(['accept', 'acceptForSession', 'decline', 'cancel']) });
        break;
      case 'item/permissions/requestApproval': {
        const req = p.permissions && typeof p.permissions === 'object' ? p.permissions : {};
        const permissions = Object.fromEntries(['fileSystem', 'network'].filter(k => req[k] != null).map(k => [k, req[k]]));
        Object.assign(a, { kind: 'permissions', permissions, decisions: [
          { id: 'turn', label: 'Allow for this turn', value: { permissions, scope: 'turn' } },
          { id: 'session', label: 'Allow for this session', value: { permissions, scope: 'session' } },
          { id: 'deny', label: 'Deny', value: { permissions: {}, scope: 'turn' } },
        ] });
        break;
      }
      case 'item/tool/requestUserInput': {
        const questions = (Array.isArray(p.questions) ? p.questions : []).filter(q => typeof q?.id === 'string').map(q => ({
          id: q.id, header: clip(str(q.header), 200), question: clip(str(q.question), 2000),
          options: (Array.isArray(q.options) ? q.options : []).map(o => ({ label: clip(str(o?.label), 200), description: clip(str(o?.description), 500) })),
          isOther: q.isOther === true, isSecret: q.isSecret === true,
        }));
        Object.assign(a, { kind: 'question', questions, decisions: [] });
        break;
      }
      case 'mcpServer/elicitation/request':
        Object.assign(a, { kind: 'elicitation', serverName: clip(str(p.serverName), 200), message: clip(str(p.message), 2000), decisions: [
          { id: 'decline', label: 'Decline', value: { action: 'decline' } },
          { id: 'cancel', label: 'Cancel', value: { action: 'cancel' } },
        ] });
        break;
      default:
        run.replyError(m.id, 'Not supported by Claude Code Console');
        return;
    }
    run.decisions.set(a.id, new Map(a.decisions.map(d => [d.id, d.value])));
    run.approvals.set(a.id, a);
    this.#changed();
  }

  // ---------- actions from the browser ----------

  async send(run, text) {
    if (run.state === 'closed') throw new Error('That run has ended');
    await this.#turn(run, text);
  }

  /**
   * Answer a request once. `decision` is one of the ids the card offered; questions take
   * `answers` (question id -> list of strings) or `decision: 'skip'`.
   * Returns false when the request is gone (answered, resolved or closed); throws on a bad decision.
   */
  answer(run, approvalId, { decision = '', answers = null } = {}) {
    const a = run.approvals.get(approvalId);
    if (!a || run.state === 'closed') return false;
    let result;
    if (a.kind === 'question') {
      if (decision === 'skip') result = { answers: {} };
      else {
        if (!answers || typeof answers !== 'object') throw new Error('Answer every question first');
        const out = {};
        for (const q of a.questions) {
          const v = answers[q.id];
          const list = (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 4000));
          if (!list.length) throw new Error('Answer every question first');
          out[q.id] = { answers: list };
        }
        result = { answers: out };
      }
    } else {
      const values = run.decisions.get(approvalId);
      if (!values?.has(decision)) throw new Error('Unknown decision');
      const v = values.get(decision);
      result = a.kind === 'command' || a.kind === 'fileChange' ? { decision: v } : v;
    }
    run.approvals.delete(approvalId);
    run.decisions.delete(approvalId);
    run.reply(a.rpcId, result);
    this.#changed();
    return true;
  }

  /** Codex takes policy overrides with the next turn, not mid-turn. */
  async setMode(run, mode) {
    if (run.state === 'closed') throw new Error('That run has ended');
    if (!MODES[mode]) throw new Error('Unknown Codex policy');
    run.mode = mode;
    this.#changed();
  }

  /** Ask Codex to stop the current turn. A refusal or timeout is reported; the run stays as it is. */
  async interrupt(run) {
    if (run.state === 'closed' || !run.turnId) return;
    try {
      await run.rpc('turn/interrupt', { threadId: run.sessionId, turnId: run.turnId });
    } catch (err) {
      throw new CodexError('interrupt', err?.message);
    }
  }

  /** End the console's own app-server. Pending requests get no answer, so nothing is granted. */
  close(key) {
    const run = this.runs.get(key);
    if (!run || run.state === 'closed') return;
    run.closing = true;
    try { run.child?.kill('SIGTERM'); } catch { /* already gone */ }
    this.#finish(run);
  }

  closeAll() {
    for (const key of this.runs.keys()) this.close(key);
  }

  #finish(run) {
    if (run.state === 'closed') return;
    run.state = 'closed';
    clearTimeout(run.idleTimer);
    run.approvals.clear();
    run.decisions.clear();
    run.rejectAll?.(new CodexError('exited'));
    this.#changed();
  }

  #trim() {
    const closed = [...this.runs.values()].filter(r => r.state === 'closed');
    for (const r of closed.slice(0, Math.max(0, closed.length - MAX_RUNS))) this.runs.delete(r.key);
  }

  snapshot() {
    return [...this.runs.values()].map(r => ({
      key: r.key,
      provider: 'codex',
      sessionId: r.sessionId,
      forkedFrom: r.forkedFrom,
      cwd: r.cwd,
      mode: r.mode,
      policy: r.policy,
      modePending: r.mode !== r.appliedMode,
      notice: r.notice || null,
      model: r.model,
      state: r.state,
      error: r.error ? redact(r.error, 300) : null,
      startedAt: r.startedAt,
      capabilities: { liveMode: false },
      approvals: [...r.approvals.values()].map(a => ({
        id: a.id, kind: a.kind, reason: a.reason, at: a.at,
        command: a.command, cwd: a.cwd, files: a.files, grantRoot: a.grantRoot,
        permissions: a.permissions, questions: a.questions, serverName: a.serverName, message: a.message,
        decisions: a.decisions.map(d => ({ id: d.id, label: d.label, persistent: Boolean(d.persistent) })),
      })),
    }));
  }
}
