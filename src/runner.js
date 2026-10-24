import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Runs Claude Code sessions from the console through the Agent SDK. Each run is one
// Claude Code process in streaming-input mode, so follow-up messages go to the same
// process. Tool approvals wait in `approvals` until the user answers in the browser.
// The process writes its transcript as usual, so the watcher and conversation view
// pick up everything it does; the runner only tracks what the transcript can't show.

const IDLE_CLOSE_MS = 10 * 60_000; // close a process that has been idle this long
const MAX_RUNS = 8;
const INPUT_MAX = 4_000;
/** Modes the console offers. bypassPermissions is left out on purpose. */
export const MODES = ['default', 'acceptEdits', 'plan', 'auto'];

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Tool input as the approval card shows it: strings clipped, nothing huge. */
function shownInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (typeof v === 'string') out[k] = clip(v, INPUT_MAX);
    else {
      const json = JSON.stringify(v) ?? '';
      out[k] = json.length > INPUT_MAX ? clip(json, INPUT_MAX) : v;
    }
  }
  return out;
}

export class Runner extends EventEmitter {
  /** `query` is the SDK's query function; injectable so tests don't spawn Claude Code. */
  constructor({ query, idleMs = IDLE_CLOSE_MS } = {}) {
    super();
    this.query = query;
    this.idleMs = idleMs;
    this.runs = new Map(); // key -> run
  }

  #changed() { this.emit('change'); }

  /** The live run for a session, if the console holds one. */
  bySession(sessionId) {
    for (const r of this.runs.values()) if (r.sessionId === sessionId && r.state !== 'closed') return r;
    return null;
  }

  /** Session ids the console's own processes hold, so they don't count as "open in a terminal". */
  ownedSessions() {
    return new Set([...this.runs.values()].filter(r => r.state !== 'closed' && r.sessionId).map(r => r.sessionId));
  }

  /**
   * Start a process. `resume` continues a session (or, with `fork`, copies it into a new one);
   * without it, a new session starts in `cwd`.
   */
  async start({ cwd, prompt, resume = null, fork = false, permissionMode = 'default', model = null }) {
    if (!this.query) throw new Error('Chat is unavailable: the Claude Agent SDK is not installed');
    const live = [...this.runs.values()].filter(r => r.state !== 'closed');
    if (live.length >= MAX_RUNS) throw new Error(`Already running ${MAX_RUNS} sessions from the console`);

    const run = {
      key: crypto.randomBytes(8).toString('hex'),
      sessionId: fork ? null : resume,
      forkedFrom: fork ? resume : null,
      cwd,
      mode: permissionMode,
      model,
      state: 'starting',   // starting | running | idle | closed
      approvals: new Map(),
      error: null,
      startedAt: Date.now(),
      queue: [],
      wake: null,
      q: null,
      idleTimer: null,
    };
    this.runs.set(run.key, run);
    this.#trim();

    const input = async function* () {
      while (run.state !== 'closed') {
        while (run.queue.length) yield run.queue.shift();
        await new Promise(resolve => { run.wake = resolve; });
      }
    };
    run.q = this.query({
      prompt: input(),
      options: {
        cwd,
        resume: resume || undefined,
        forkSession: fork || undefined,
        permissionMode,
        ...(model ? { model } : {}),
        canUseTool: (tool, toolInput, opts) => this.#ask(run, tool, toolInput, opts),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-code-console/0.1' },
      },
    });
    this.#push(run, prompt);
    this.#consume(run);
    this.#changed();
    return run;
  }

  #push(run, text) {
    clearTimeout(run.idleTimer);
    run.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    run.state = run.state === 'starting' ? 'starting' : 'running';
    run.error = null;
    run.wake?.();
  }

  async #consume(run) {
    try {
      for await (const m of run.q) {
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) run.sessionId = m.session_id;
        if (m.type === 'system' && m.subtype === 'session_state_changed') {
          run.state = m.state === 'idle' ? 'idle' : 'running';
        } else if (m.type === 'result') {
          run.state = 'idle';
          if (m.is_error || m.subtype !== 'success') run.error = m.errors?.[0] || m.subtype.replace(/_/g, ' ');
          run.idleTimer = setTimeout(() => this.close(run.key), this.idleMs);
          run.idleTimer.unref?.();
        } else if (run.state === 'starting' && m.type !== 'system') {
          run.state = 'running';
        }
        this.#changed();
      }
    } catch (err) {
      run.error = err?.message || String(err);
    }
    this.#finish(run);
  }

  #finish(run) {
    if (run.state === 'closed') return;
    run.state = 'closed';
    clearTimeout(run.idleTimer);
    for (const a of run.approvals.values()) a.resolve({ behavior: 'deny', message: 'The console closed this session.' });
    run.approvals.clear();
    run.wake?.();
    this.#changed();
  }

  /** Forget old closed runs. */
  #trim() {
    const closed = [...this.runs.values()].filter(r => r.state === 'closed');
    for (const r of closed.slice(0, Math.max(0, closed.length - MAX_RUNS))) this.runs.delete(r.key);
  }

  #ask(run, tool, input, opts = {}) {
    return new Promise(resolve => {
      const id = opts.toolUseID || crypto.randomBytes(6).toString('hex');
      const approval = {
        id,
        tool,
        input,
        title: opts.title || '',
        displayName: opts.displayName || tool,
        description: opts.description || '',
        reason: opts.decisionReason || '',
        blockedPath: opts.blockedPath || '',
        suggestions: opts.suppressAlwaysAllowRule ? [] : (opts.suggestions || []),
        defaultToNo: Boolean(opts.defaultToNo),
        at: Date.now(),
        resolve: result => { run.approvals.delete(id); resolve(result); this.#changed(); },
      };
      run.approvals.set(id, approval);
      opts.signal?.addEventListener('abort', () => {
        if (run.approvals.delete(id)) this.#changed();
      });
      this.#changed();
    });
  }

  // ---------- actions from the browser ----------

  send(run, text) {
    if (run.state === 'closed') throw new Error('That run has ended');
    this.#push(run, text);
    this.#changed();
  }

  /**
   * Answer an approval. `decision`: { allow, always, message, answers }.
   * `answers` (question text -> chosen label) is for AskUserQuestion.
   */
  answer(run, approvalId, { allow, always = false, message = '', answers = null } = {}) {
    const a = run.approvals.get(approvalId);
    if (!a) return false;
    if (allow) {
      const updatedInput = answers && a.tool === 'AskUserQuestion' ? { ...a.input, answers } : a.input;
      a.resolve({ behavior: 'allow', updatedInput, ...(always && a.suggestions.length ? { updatedPermissions: a.suggestions } : {}) });
    } else {
      a.resolve({ behavior: 'deny', message: message.trim() || 'The user denied this in Claude Code Console.' });
    }
    return true;
  }

  async setMode(run, mode) {
    if (run.state === 'closed') throw new Error('That run has ended');
    await run.q.setPermissionMode(mode);
    run.mode = mode;
    this.#changed();
  }

  async interrupt(run) {
    if (run.state === 'closed') return;
    await run.q.interrupt();
  }

  close(key) {
    const run = this.runs.get(key);
    if (!run || run.state === 'closed') return;
    try { run.q?.close(); } catch { /* already gone */ }
    this.#finish(run);
  }

  closeAll() {
    for (const key of this.runs.keys()) this.close(key);
  }

  /** What the browser needs to know about each run. */
  snapshot() {
    return [...this.runs.values()].map(r => ({
      key: r.key,
      sessionId: r.sessionId,
      forkedFrom: r.forkedFrom,
      cwd: r.cwd,
      mode: r.mode,
      model: r.model,
      state: r.state,
      error: r.error,
      startedAt: r.startedAt,
      approvals: [...r.approvals.values()].map(a => ({
        id: a.id, tool: a.tool, input: shownInput(a.input), title: a.title, displayName: a.displayName,
        description: a.description, reason: a.reason, blockedPath: a.blockedPath,
        canAlways: a.suggestions.length > 0, defaultToNo: a.defaultToNo, at: a.at,
      })),
    }));
  }
}

/** Load the SDK if it's installed; the console still works read-only without it. */
export async function loadQuery() {
  try {
    return (await import('@anthropic-ai/claude-agent-sdk')).query;
  } catch {
    return null;
  }
}
