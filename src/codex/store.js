import path from 'node:path';
import { STALE_AFTER_MS, clip, dayKey, estimate, phaseStatus } from '../store.js';
import { costOf, emptyUsage } from '../pricing.js';
import { redact } from './errors.js';

// Folds Codex CLI rollout files ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl) into the
// same session summaries the Claude store produces. Validated against Codex CLI 0.164.0.
//
// - Every rollout starts with a `session_meta` line naming its thread. Lines are tied to
//   the file they came from, never to ids inside them, so a stray line can't move usage.
// - Only Codex CLI sessions are shown: source `cli` (the TUI) or `exec`, threads the
//   console started (thread_source `claude_code_console`), and subagents of shown threads.
// - A fork doesn't copy its parent's lines; session_meta.history_base points at them.
//   Usage is therefore only ever counted from a session's own file.

export const CONSOLE_SOURCE = 'claude_code_console';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLI_SOURCES = new Set(['cli', 'exec']);
const MAX_ANCESTRY = 16;
const LOG_LIMIT = 60;
const FILES_LIMIT = 12;
const TOOL_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const TOOL_OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

const isId = v => typeof v === 'string' && UUID_RE.test(v);
const tsOf = e => (typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) || null : null);

/** session_meta.source: a string, or { subagent | subAgent: { thread_spawn: {...} } }. */
function spawnOf(source) {
  const sub = source && typeof source === 'object' ? (source.subagent ?? source.subAgent) : null;
  const spawn = sub && typeof sub === 'object' ? sub.thread_spawn : null;
  return spawn && typeof spawn === 'object' ? spawn : null;
}

/** Normalise one model response's usage. OpenAI counts cached input and cache writes inside input_tokens. */
export function usageFromCodex(u = {}) {
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(u.input_tokens), cached = n(u.cached_input_tokens), write = n(u.cache_write_input_tokens);
  return {
    input: Math.max(0, input - cached - write),
    output: n(u.output_tokens), // includes reasoning tokens
    cacheWrite5m: write,
    cacheWrite1h: 0,
    cacheRead: cached,
  };
}

/** A short label for a tool call from the rollout: the command for shell-ish calls. */
function callTarget(p) {
  const raw = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
  let cmd = '';
  try {
    const args = JSON.parse(raw);
    cmd = Array.isArray(args.command) ? args.command.join(' ') : args.cmd || args.command || '';
  } catch {
    // Code-mode `exec` calls carry a script; show the first command it runs, if it names one.
    cmd = raw.match(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] || raw;
  }
  return clip(String(cmd || ''), 80);
}

function newSession(id) {
  return {
    id,
    provider: 'codex',
    file: '',
    meta: null,              // { source, threadSource, originator, forkedFrom, historyBase, parentId, role, nickname }
    cwd: '',
    gitBranch: '',
    version: '',
    model: '',
    approvalPolicy: '',
    sandbox: '',
    startedAt: null,
    lastActivity: null,
    lastMainActivity: null,
    phase: 'idle',
    phaseSince: null,
    pendingTools: new Map(), // call_id -> { name, target, at }
    error: null,
    lastPrompt: '',
    lastAnswer: '',
    turns: 0,
    apiCalls: 0,
    compactions: 0,
    contextTokens: 0,
    contextWindow: null,
    usageByModel: new Map(),
    spendByDay: new Map(),
    responses: new Set(),    // response ids counted; kept for the session's lifetime so a replay can't recount
    usageSkipped: 0,         // usage records without trustworthy owner or id
    log: [],
    files: [],
  };
}

export class CodexStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.sessions = new Map(); // thread id -> session (top-level threads and subagents alike)
    this.fileOwner = new Map(); // rollout path -> thread id, from its session_meta
    this.metas = new Map();     // thread id -> what session_meta said, kept so a pruned session that wakes up keeps it
    this.version = 0;
  }

  ingestLine(line, filePath = '') {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    this.ingest(e, filePath);
  }

  ingest(e, filePath = '') {
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') return;
    if (e.type === 'session_meta') return this.#meta(e, filePath);
    const id = this.fileOwner.get(filePath);
    if (!id) return; // no session_meta seen for this file: nothing to attach it to
    const s = this.#session(id);
    const ts = tsOf(e);
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    this.version++;
    if (ts) {
      if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
      if (!s.lastActivity || ts > s.lastActivity) s.lastActivity = ts;
      if (!s.lastMainActivity || ts > s.lastMainActivity) s.lastMainActivity = ts;
    }
    switch (e.type) {
      case 'turn_context': return this.#turnContext(s, p);
      case 'token_usage_record': return this.#usage(s, p, ts);
      case 'event_msg': return this.#event(s, p, ts);
      case 'response_item': return this.#responseItem(s, p, ts);
      case 'compacted': return this.#compacted(s, ts);
      default: return; // world_state and anything newer: ignored
    }
  }

  #session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = newSession(id);
      Object.assign(s, this.metas.get(id));
      this.sessions.set(id, s);
    }
    return s;
  }

  #meta(e, filePath) {
    const p = e.payload || {};
    const id = p.id ?? p.session_id;
    if (!isId(id)) return;
    // One file belongs to one thread: the first session_meta wins.
    const owner = this.fileOwner.get(filePath);
    if (owner && owner !== id) return;
    this.fileOwner.set(filePath, id);
    const s = this.#session(id);
    if (filePath) s.file = filePath;
    const spawn = spawnOf(p.source);
    const base = p.history_base && typeof p.history_base === 'object' ? p.history_base : null;
    s.meta = {
      source: typeof p.source === 'string' ? p.source : spawn ? 'subagent' : 'unknown',
      threadSource: typeof p.thread_source === 'string' ? p.thread_source : '',
      originator: typeof p.originator === 'string' ? p.originator : '',
      forkedFrom: isId(p.forked_from_id) ? p.forked_from_id : null,
      historyBase: base ? { threadId: base.thread_id, endByteOffset: base.end_byte_offset } : null,
      parentId: spawn && isId(spawn.parent_thread_id) ? spawn.parent_thread_id : null,
      role: typeof spawn?.agent_role === 'string' ? spawn.agent_role : '',
      nickname: typeof spawn?.agent_nickname === 'string' ? spawn.agent_nickname : '',
    };
    if (typeof p.cwd === 'string') s.cwd = p.cwd;
    if (typeof p.cli_version === 'string') s.version = p.cli_version;
    if (typeof p.git?.branch === 'string') s.gitBranch = p.git.branch;
    const ts = tsOf(e) || (typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : null);
    if (ts && (!s.startedAt || ts < s.startedAt)) s.startedAt = ts;
    this.metas.set(id, { file: s.file, meta: s.meta, cwd: s.cwd, version: s.version, gitBranch: s.gitBranch });
    this.version++;
  }

  #turnContext(s, p) {
    if (typeof p.model === 'string' && p.model) s.model = p.model;
    if (typeof p.approval_policy === 'string') s.approvalPolicy = p.approval_policy;
    if (typeof p.sandbox_policy?.type === 'string') s.sandbox = p.sandbox_policy.type;
    if (typeof p.cwd === 'string' && p.cwd) s.cwd = p.cwd;
  }

  #setPhase(s, phase, ts) {
    if (s.phase !== phase) { s.phase = phase; s.phaseSince = ts ?? s.phaseSince; }
  }

  #log(s, at, kind, text) {
    if (!text) return;
    s.log.push({ at, kind, text: clip(text) });
    if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
  }

  /**
   * One model response's tokens. Counted only when the record names this file's own thread
   * (thread_id and session_id must agree when both are given) and carries a response id
   * not seen before in this session. Anything else is skipped and the usage marked incomplete.
   */
  #usage(s, p, ts) {
    const owners = [p.thread_id, p.session_id].filter(v => v != null);
    const trusted = owners.length > 0 && owners.every(v => v === s.id);
    const rid = typeof p.response_id === 'string' && p.response_id ? p.response_id : null;
    if (!trusted || !rid || !p.usage || typeof p.usage !== 'object') { s.usageSkipped++; return; }
    if (s.responses.has(rid)) return; // the same record read again
    s.responses.add(rid);
    s.apiCalls++;
    const model = s.model || 'unknown';
    const u = usageFromCodex(p.usage);
    const bucket = s.usageByModel.get(model) || emptyUsage();
    for (const k of Object.keys(u)) bucket[k] += u[k];
    s.usageByModel.set(model, bucket);
    const cost = ts ? costOf(model, u) : null;
    if (cost) {
      const day = dayKey(ts);
      s.spendByDay.set(day, (s.spendByDay.get(day) || 0) + cost);
    }
  }

  #event(s, p, ts) {
    switch (p.type) {
      case 'task_started':
        if (Number.isFinite(p.model_context_window)) s.contextWindow = p.model_context_window;
        s.error = null;
        this.#setPhase(s, 'working', ts);
        return;
      case 'task_complete':
        s.pendingTools.clear();
        if (typeof p.last_agent_message === 'string') s.lastAnswer = clip(p.last_agent_message, 400);
        this.#setPhase(s, 'waiting', ts);
        return;
      case 'turn_aborted':
        s.pendingTools.clear();
        this.#setPhase(s, 'waiting', ts);
        this.#log(s, ts, 'info', p.reason === 'interrupted' ? 'Interrupted by user' : 'Turn aborted');
        return;
      case 'token_count': {
        const info = p.info && typeof p.info === 'object' ? p.info : null;
        if (Number.isFinite(info?.model_context_window)) s.contextWindow = info.model_context_window;
        const last = info?.last_token_usage;
        if (Number.isFinite(last?.total_tokens)) s.contextTokens = last.total_tokens;
        return;
      }
      case 'error':
      case 'stream_error': {
        const message = redact(p.message || 'Codex reported an error', 160);
        s.error = { message, at: ts };
        if (p.type === 'error') this.#setPhase(s, 'error', ts);
        this.#log(s, ts, 'error', message);
        return;
      }
      case 'context_compacted':
        return this.#compacted(s, ts);
      case 'item_completed':
        return this.#item(s, p.item, ts);
      default:
        return;
    }
  }

  #compacted(s, ts) {
    s.compactions++;
    this.#log(s, ts, 'info', 'Compacted');
  }

  #item(s, item, ts) {
    if (!item || typeof item !== 'object') return;
    switch (item.type) {
      case 'UserMessage': {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
        if (!text.trim()) return;
        s.turns++;
        s.lastPrompt = clip(text, 400);
        s.error = null;
        this.#setPhase(s, 'working', ts);
        this.#log(s, ts, 'prompt', text);
        return;
      }
      case 'AgentMessage': {
        const text = (Array.isArray(item.content) ? item.content : []).map(c => (typeof c?.text === 'string' ? c.text : '')).join('');
        this.#log(s, ts, 'text', text);
        return;
      }
      case 'CommandExecution': {
        const cmd = Array.isArray(item.command) ? item.command.at(-1) : item.command;
        this.#log(s, ts, 'tool', `Shell · ${clip(String(cmd || ''), 80)}`);
        return;
      }
      case 'FileChange': {
        const files = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [];
        for (const f of files) s.files = [f, ...s.files.filter(x => x !== f)].slice(0, FILES_LIMIT);
        this.#log(s, ts, 'tool', `Edit · ${files.map(f => path.basename(f)).join(', ')}`);
        return;
      }
      default:
        if (typeof item.type === 'string' && item.type !== 'Reasoning') this.#log(s, ts, 'tool', item.kind || item.type);
    }
  }

  #responseItem(s, p, ts) {
    if (TOOL_CALLS.has(p.type) && typeof p.call_id === 'string') {
      s.pendingTools.set(p.call_id, { name: p.name || 'tool', target: callTarget(p), at: ts });
      this.#setPhase(s, 'tool', ts);
    } else if (TOOL_OUTPUTS.has(p.type) && typeof p.call_id === 'string') {
      s.pendingTools.delete(p.call_id);
      if (!s.pendingTools.size && s.phase === 'tool') this.#setPhase(s, 'working', ts);
    } else if (p.type === 'compaction') {
      this.#compacted(s, ts);
    }
  }

  // ---------- read side ----------

  /** Whether a top-level thread is a Codex CLI session the console shows. */
  #shown(s) {
    const m = s.meta;
    if (!m || m.parentId) return false;
    return CLI_SOURCES.has(m.source) || m.threadSource === CONSOLE_SOURCE;
  }

  /** Subagents of `id`, wherever they were discovered. */
  #children(id) {
    return [...this.sessions.values()].filter(c => c.meta?.parentId === id);
  }

  /** The thread a session belongs to on screen: itself, or the shown thread a subagent works for. */
  rootOf(id) {
    const seen = new Set();
    let s = this.sessions.get(id);
    while (s?.meta?.parentId && !seen.has(s.id) && seen.size < MAX_ANCESTRY) {
      seen.add(s.id);
      s = this.sessions.get(s.meta.parentId);
    }
    return s && this.#shown(s) ? s : null;
  }

  /** Shown top-level sessions only. */
  get(id) {
    const s = this.sessions.get(id);
    return s && this.#shown(s) ? s : null;
  }

  /**
   * Where a fork's inherited history comes from, oldest first: [{ file, end }] byte ranges of
   * known rollout files. `missing` explains the first link that couldn't be followed. Only
   * thread ids are followed, and only to files the watcher found; nothing is read here.
   */
  ancestry(id) {
    const chain = [];
    const seen = new Set([id]);
    let s = this.sessions.get(id);
    while (s?.meta?.historyBase) {
      const { threadId, endByteOffset } = s.meta.historyBase;
      if (!isId(threadId) || (s.meta.forkedFrom && s.meta.forkedFrom !== threadId)) return { chain, missing: { id: null, reason: 'invalid reference' } };
      if (!Number.isSafeInteger(endByteOffset) || endByteOffset < 0) return { chain, missing: { id: threadId, reason: 'invalid offset' } };
      if (seen.has(threadId)) return { chain, missing: { id: threadId, reason: 'cyclic reference' } };
      if (seen.size > MAX_ANCESTRY) return { chain, missing: { id: threadId, reason: 'too many nested forks' } };
      seen.add(threadId);
      const parent = this.sessions.get(threadId);
      if (!parent?.file) return { chain, missing: { id: threadId, reason: 'not loaded' } };
      chain.unshift({ id: threadId, file: parent.file, end: endByteOffset });
      s = parent;
    }
    return { chain, missing: null };
  }

  /** Spend, tokens and subagents of a session, with its subagents' usage added in. */
  summarize(s, now = this.now()) {
    const kids = this.#children(s.id);
    const usage = new Map();
    const spendByDay = new Map();
    let usageSkipped = s.usageSkipped, apiCalls = s.apiCalls;
    for (const x of [s, ...kids]) {
      for (const [m, u] of x.usageByModel) {
        const b = usage.get(m) || emptyUsage();
        for (const k of Object.keys(b)) b[k] += u[k];
        usage.set(m, b);
      }
      for (const [d, v] of x.spendByDay) spendByDay.set(d, (spendByDay.get(d) || 0) + v);
      if (x !== s) { usageSkipped += x.usageSkipped; apiCalls += x.apiCalls; }
    }
    const { usd, unknownModels, totals, byModel } = estimate(usage);
    const subagents = kids.map(k => ({
      id: k.id,
      type: k.meta.role,
      description: k.meta.nickname || k.lastPrompt || '',
      tool: [...k.pendingTools.values()].at(-1)?.name || '',
      outputTokens: [...k.usageByModel.values()].reduce((n, u) => n + u.output, 0),
      startedAt: k.startedAt,
      lastActivity: k.lastActivity,
      status: k.phase === 'waiting' ? 'done'
        : k.lastActivity && now - k.lastActivity < STALE_AFTER_MS ? 'running' : 'stale',
    })).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    const subActive = subagents.some(a => a.status === 'running');
    const status = phaseStatus(s.phase, s.lastMainActivity, subActive, now);
    const pending = [...s.pendingTools.values()].at(-1) || null;
    const parts = s.cwd.split(/[\\/]/).filter(Boolean);
    const incomplete = unknownModels.length > 0 || usageSkipped > 0;
    const window = s.contextWindow || null;
    return {
      id: s.id,
      provider: 'codex',
      cwd: s.cwd,
      project: parts.slice(-2).join('/') || s.id.slice(0, 8),
      title: '',
      gitBranch: s.gitBranch,
      version: s.version,
      entrypoint: s.meta?.source || '',
      permissionMode: '',
      policy: { approval: s.approvalPolicy, sandbox: s.sandbox },
      model: s.model,
      status,
      phaseSince: s.phaseSince,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
      currentTool: pending && (status === 'tool' || status === 'stale') ? { name: pending.name, target: pending.target, since: pending.at } : null,
      error: status === 'error' ? s.error : null,
      summary: s.lastAnswer,
      lastPrompt: s.lastPrompt,
      turns: s.turns,
      apiCalls,
      compactions: s.compactions,
      context: { tokens: s.contextTokens, window, pct: window ? Math.min(100, (s.contextTokens / window) * 100) : 0 },
      tokens: totals,
      byModel,
      cost: {
        // Unpriced models or skipped records make the dollar figure unknown rather than a partial sum.
        usd: incomplete ? null : usd,
        source: incomplete ? 'unknown' : 'estimate',
        estimated: usd,
        reported: null,
        unknownModels,
        incomplete,
        usageSkipped,
      },
      spendByDay: Object.fromEntries(spendByDay),
      forkedFrom: s.meta?.forkedFrom || null,
      linesAdded: 0,
      linesRemoved: 0,
      subagents,
      files: s.files,
      log: s.log,
    };
  }

  snapshot(now = this.now()) {
    const out = [];
    for (const s of this.sessions.values()) {
      // A TUI opened and closed without a prompt leaves an empty rollout: not a session worth showing.
      if (s.startedAt && (s.turns || s.apiCalls) && this.#shown(s)) out.push(this.summarize(s, now));
    }
    return out;
  }

  /**
   * Drop sessions with no activity since `cutoff`, with their usage and dedupe state. The file
   * owner and session_meta stay (a few strings each): the tailer only reads new bytes, so a
   * session that wakes up again continues from its own file without recounting anything.
   */
  prune(cutoff) {
    for (const [id, s] of this.sessions) {
      if ((s.lastActivity || s.startedAt || 0) < cutoff) this.sessions.delete(id);
    }
  }
}
