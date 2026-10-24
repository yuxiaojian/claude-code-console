import fs from 'node:fs';
import path from 'node:path';
import { contextWindow, costOf, emptyUsage, usageFromApi } from './pricing.js';

// How long a session may go without events before we stop trusting its phase.
export const STALE_AFTER_MS = 10 * 60_000;   // working/tool with no events -> "stale"
export const WAITING_FOR_MS = 60 * 60_000;   // "waiting for you" decays to "idle"
export const ERROR_FOR_MS = 5 * 60_000;      // an API error with no later events

const LOG_LIMIT = 60;
const FILES_LIMIT = 12;
const MSG_USAGE_LIMIT = 512;
const OWNERS_LIMIT = 500_000; // line uuids remembered for fork detection
const TEXT_LIMIT = 240;

// Tools that block on the human rather than on the machine.
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Local calendar day, YYYY-MM-DD. Spend is bucketed by the day each API call happened. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const clip = (s, n = TEXT_LIMIT) => {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/** A short human label for what a tool call is acting on. */
export function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  const fp = input.file_path || input.notebook_path;
  if (fp) return path.basename(fp);
  if (name === 'Bash' && input.command) return clip(input.command, 80);
  for (const k of ['description', 'pattern', 'url', 'query', 'skill', 'path', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return clip(input[k], 80);
  }
  return '';
}

/**
 * Turn a user message into prompt text, or null if it isn't something the human typed
 * (tool results, command stdout, compaction summaries, interrupts).
 */
export function promptText(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some(b => b?.type === 'tool_result')) return null;
    text = content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
  }
  if (!text) return null;
  if (text.startsWith('<local-command-') || text.startsWith('<command-message>')) return null;
  if (text.startsWith('[Request interrupted')) return null;
  if (text.startsWith('This session is being continued from a previous conversation')) return null;
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return args ? `${cmd[1]} ${args}` : cmd[1];
  }
  return text;
}

export function estimate(usageByModel) {
  let usd = 0;
  const unknownModels = [];
  const totals = emptyUsage();
  const byModel = [];
  for (const [model, u] of usageByModel) {
    const cost = costOf(model, u);
    if (cost == null) unknownModels.push(model); else usd += cost;
    for (const k of Object.keys(totals)) totals[k] += u[k];
    byModel.push({ model, ...u, cost });
  }
  return { usd, unknownModels, totals, byModel };
}

function newSession(id) {
  return {
    id,
    cwd: '',
    file: '',                // the main transcript, for the conversation view
    title: '',
    agentName: '',
    gitBranch: '',
    version: '',
    entrypoint: '',
    permissionMode: '',
    model: '',
    startedAt: null,
    lastActivity: null,      // any thread, ms
    lastMainActivity: null,  // main thread only, ms
    phase: 'idle',
    phaseSince: null,
    pendingTools: new Map(), // tool_use id -> { name, target, at }
    completedToolUses: new Set(),
    error: null,
    summary: '',
    lastPrompt: '',
    turns: 0,
    apiCalls: 0,
    compactions: 0,
    compactedAt: null,       // messages Claude Code replays after compaction carry older timestamps
    contextTokens: 0,
    usageByModel: new Map(),
    msgUsage: new Map(),     // message.id -> { model, usage } (cumulative per message)
    spendByDay: new Map(),   // dayKey -> estimated USD, for today / this-week totals
    reportedCost: null,
    estimatedAtReport: 0,    // our estimate when the last cost-state was written
    linesAdded: 0,
    linesRemoved: 0,
    subagents: new Map(),
    forkedFrom: null,        // a fork starts with a copy of another session's lines
    log: [],
    files: [],
  };
}

/** A session's status from its last phase and how long ago the main thread was active. Shared by providers. */
export function phaseStatus(phase, lastMainActivity, subActive, now) {
  const age = lastMainActivity ? now - lastMainActivity : Infinity;
  switch (phase) {
    case 'ended': return 'ended';
    case 'error': return age < ERROR_FOR_MS ? 'error' : 'idle';
    case 'question': return age < WAITING_FOR_MS ? 'question' : 'idle';
    case 'waiting': return age < WAITING_FOR_MS ? 'waiting' : 'idle';
    case 'working':
    case 'tool': return age < STALE_AFTER_MS || subActive ? phase : 'stale';
    default: return 'idle';
  }
}

export class Store {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.owners = new Map(); // main-thread line uuid -> the session that wrote it first
    this.version = 0; // bumped on every applied event, lets the server skip no-op pushes
  }

  /** Parse and apply one JSONL line. `filePath` is used to find subagent metadata. */
  ingestLine(line, filePath = '') {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    this.ingest(event, filePath);
  }

  ingest(e, filePath = '') {
    const id = e?.sessionId;
    if (!id || typeof id !== 'string') return;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;
    const isSub = Boolean(e.agentId) || e.isSidechain === true;
    if (!isSub && e.uuid && this.#copied(id, e.uuid)) return;
    const s = this.#session(id);
    this.version++;

    if (ts) {
      if (!s.startedAt || ts < s.startedAt) s.startedAt = ts;
      if (!s.lastActivity || ts > s.lastActivity) s.lastActivity = ts;
      if (!isSub && (!s.lastMainActivity || ts > s.lastMainActivity)) s.lastMainActivity = ts;
    }
    if (!isSub) {
      if (filePath && (!s.file || path.basename(filePath) === `${id}.jsonl`)) s.file = filePath;
      if (e.cwd) s.cwd = e.cwd;
      if (e.gitBranch) s.gitBranch = e.gitBranch;
      if (e.version) s.version = e.version;
      if (e.entrypoint) s.entrypoint = e.entrypoint;
      if (e.permissionMode) s.permissionMode = e.permissionMode;
    }

    switch (e.type) {
      case 'ai-title': if (e.aiTitle) s.title = e.aiTitle; return;
      case 'agent-name': if (e.agentName) s.agentName = e.agentName; return;
      case 'permission-mode': return; // handled above
      case 'cost-state': return this.#costState(s, e);
      case 'system': return isSub ? undefined : this.#system(s, e, ts);
      case 'user': return isSub ? this.#subUser(s, e, ts, filePath) : this.#user(s, e, ts);
      case 'assistant': return this.#assistant(s, e, ts, isSub, filePath);
      default: return;
    }
  }

  /**
   * A fork copies its original's history, keeping each line's uuid. Copied lines are the
   * original's work (spend, turns, timestamps), so count them once, under the original.
   */
  #copied(id, uuid) {
    const owner = this.owners.get(uuid);
    if (owner === undefined) {
      if (this.owners.size >= OWNERS_LIMIT) this.owners.delete(this.owners.keys().next().value);
      this.owners.set(uuid, id);
      return false;
    }
    if (owner === id || !this.sessions.has(owner)) return false;
    const s = this.#session(id);
    if (!s.forkedFrom) { s.forkedFrom = owner; this.version++; }
    return true;
  }

  #session(id) {
    let s = this.sessions.get(id);
    if (!s) { s = newSession(id); this.sessions.set(id, s); }
    return s;
  }

  #setPhase(s, phase, ts) {
    if (s.phase !== phase) { s.phase = phase; s.phaseSince = ts ?? s.phaseSince; }
  }

  #log(s, at, kind, text) {
    if (!text) return;
    s.log.push({ at, kind, text: clip(text) });
    if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
  }

  #touchFile(s, fp) {
    s.files = [fp, ...s.files.filter(f => f !== fp)].slice(0, FILES_LIMIT);
  }

  #costState(s, e) {
    if (typeof e.totalCostUSD === 'number') {
      // Cumulative across resumes, and includes calls that never reach the transcript
      // (title generation, permission classifiers), so it beats our estimate.
      s.reportedCost = e.totalCostUSD;
      s.estimatedAtReport = estimate(s.usageByModel).usd;
    }
    s.linesAdded = e.totalLinesAdded ?? s.linesAdded;
    s.linesRemoved = e.totalLinesRemoved ?? s.linesRemoved;
    // Claude Code writes cost-state as the session exits. Anything after it is a resume.
    s.pendingTools.clear();
    this.#setPhase(s, 'ended', s.lastMainActivity);
  }

  #system(s, e, ts) {
    switch (e.subtype) {
      case 'api_error': {
        const cause = e.error?.error?.message || e.error?.message || e.cause?.code || e.error?.cause?.code || 'API error';
        const retry = e.retryAttempt ? ` (retry ${e.retryAttempt}/${e.maxRetries ?? '?'})` : '';
        s.error = { message: clip(cause + retry, 160), at: ts };
        this.#setPhase(s, 'error', ts);
        this.#log(s, ts, 'error', cause + retry);
        return;
      }
      case 'turn_duration':
        s.pendingTools.clear();
        if (s.phase !== 'error') this.#setPhase(s, 'waiting', ts);
        return;
      case 'compact_boundary': {
        s.compactions++;
        if (ts) s.compactedAt = ts;
        const post = e.compactMetadata?.postTokens;
        if (post) s.contextTokens = post;
        this.#log(s, ts, 'info', `Compacted${post ? ` → ${post.toLocaleString('en-US')} tokens` : ''}`);
        return;
      }
      case 'away_summary':
        if (typeof e.content === 'string') s.summary = clip(e.content.replace(/\s*\(disable recaps in \/config\)\s*$/, ''), 400);
        return;
      default:
        return;
    }
  }

  #user(s, e, ts) {
    const content = e.message?.content;
    if (Array.isArray(content)) {
      let sawResult = false;
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        sawResult = true;
        s.pendingTools.delete(b.tool_use_id);
        s.completedToolUses.add(b.tool_use_id);
        for (const sub of s.subagents.values()) if (sub.toolUseId === b.tool_use_id) sub.done = true;
      }
      if (sawResult) {
        if (s.pendingTools.size === 0) this.#setPhase(s, 'working', ts);
        else this.#phaseFromPending(s, ts);
        return;
      }
    }
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.find(b => b?.type === 'text')?.text : '';
    if (text?.startsWith('[Request interrupted')) {
      s.pendingTools.clear();
      this.#setPhase(s, 'waiting', ts);
      this.#log(s, ts, 'info', 'Interrupted by user');
      return;
    }
    // Local slash commands (/compact, /mcp, /model…) finish with their stdout; no model turn follows.
    if (text?.startsWith('<local-command-stdout>')) {
      if (s.phase === 'working') this.#setPhase(s, 'waiting', ts);
      return;
    }
    if (e.isMeta) return;
    if (s.compactedAt && ts && ts < s.compactedAt) return; // replayed into the compacted transcript
    const prompt = promptText(content);
    if (!prompt) return;
    s.turns++;
    s.lastPrompt = clip(prompt, 400);
    s.error = null;
    s.pendingTools.clear();
    this.#setPhase(s, 'working', ts);
    this.#log(s, ts, 'prompt', prompt);
  }

  #phaseFromPending(s, ts) {
    const tools = [...s.pendingTools.values()];
    this.#setPhase(s, tools.some(t => ASKS_USER.has(t.name)) ? 'question' : 'tool', ts);
  }

  #accountUsage(s, msg, ts) {
    if (!msg.usage || !msg.id || msg.model === '<synthetic>') return 0;
    const model = msg.model || s.model || 'unknown';
    const curr = usageFromApi(msg.usage);
    const prev = s.msgUsage.get(msg.id);
    if (!prev) s.apiCalls++;
    // Each line of a streamed message repeats the message's running usage, so add only the delta.
    const bucket = s.usageByModel.get(model) || emptyUsage();
    const delta = emptyUsage();
    for (const k of Object.keys(curr)) {
      delta[k] = Math.max(0, curr[k] - (prev?.usage[k] || 0));
      bucket[k] += delta[k];
    }
    s.usageByModel.set(model, bucket);
    const cost = ts ? costOf(model, delta) : null;
    if (cost) {
      const day = dayKey(ts);
      s.spendByDay.set(day, (s.spendByDay.get(day) || 0) + cost);
    }
    s.msgUsage.delete(msg.id);
    s.msgUsage.set(msg.id, { model, usage: curr });
    if (s.msgUsage.size > MSG_USAGE_LIMIT) s.msgUsage.delete(s.msgUsage.keys().next().value);
    return delta.output;
  }

  #assistant(s, e, ts, isSub, filePath) {
    const msg = e.message || {};
    const outDelta = this.#accountUsage(s, msg, ts);
    if (isSub) return this.#subAssistant(s, e, ts, filePath, outDelta);

    if (msg.model === '<synthetic>') {
      const text = Array.isArray(msg.content) ? msg.content.find(b => b?.type === 'text')?.text : '';
      if (e.isApiErrorMessage) {
        s.error = { message: clip(text || e.error || 'API error', 160), at: ts };
        this.#setPhase(s, 'error', ts);
        this.#log(s, ts, 'error', text || e.error);
      } else {
        this.#setPhase(s, 'waiting', ts);
      }
      return;
    }

    if (msg.model) s.model = msg.model;
    if (msg.usage) {
      const u = usageFromApi(msg.usage);
      s.contextTokens = u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead + u.output;
    }
    s.error = null;

    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'tool_use') {
        const target = toolTarget(b.name, b.input);
        if (b.id && !s.completedToolUses.has(b.id)) s.pendingTools.set(b.id, { name: b.name, target, at: ts });
        if (FILE_TOOLS.has(b.name) && (b.input?.file_path || b.input?.notebook_path)) {
          this.#touchFile(s, b.input.file_path || b.input.notebook_path);
        }
        this.#log(s, ts, 'tool', target ? `${b.name} · ${target}` : b.name);
      } else if (b?.type === 'text' && b.text?.trim()) {
        this.#log(s, ts, 'text', b.text);
      }
    }

    const stop = msg.stop_reason;
    if (stop && stop !== 'tool_use' && stop !== 'pause_turn') {
      s.pendingTools.clear();
      this.#setPhase(s, 'waiting', ts);
    } else if (s.pendingTools.size) {
      this.#phaseFromPending(s, ts);
    } else {
      this.#setPhase(s, 'working', ts);
    }
  }

  #subagent(s, e, filePath) {
    const aid = e.agentId || 'sidechain';
    let sub = s.subagents.get(aid);
    if (!sub) {
      sub = {
        id: aid,
        type: '',
        description: '',
        toolUseId: null,
        hidden: aid.startsWith('acompact') || aid === 'sidechain',
        done: false,
        startedAt: null,
        lastActivity: null,
        outputTokens: 0,
        tool: '',
      };
      // Claude Code writes agent-<id>.meta.json next to agent-<id>.jsonl.
      if (filePath && e.agentId) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), `agent-${aid}.meta.json`), 'utf8'));
          sub.type = meta.agentType || '';
          sub.description = meta.description || '';
          sub.toolUseId = meta.toolUseId || null;
          if (sub.toolUseId && s.completedToolUses.has(sub.toolUseId)) sub.done = true;
        } catch { /* no meta file (older Claude Code) */ }
      }
      s.subagents.set(aid, sub);
    }
    return sub;
  }

  #subTouch(sub, ts) {
    if (!ts) return;
    if (!sub.startedAt || ts < sub.startedAt) sub.startedAt = ts;
    if (!sub.lastActivity || ts > sub.lastActivity) sub.lastActivity = ts;
  }

  #subUser(s, e, ts, filePath) {
    const sub = this.#subagent(s, e, filePath);
    this.#subTouch(sub, ts);
    if (!sub.description) {
      const p = promptText(e.message?.content);
      if (p) sub.description = clip(p, 120);
    }
  }

  #subAssistant(s, e, ts, filePath, outDelta) {
    const sub = this.#subagent(s, e, filePath);
    this.#subTouch(sub, ts);
    sub.outputTokens += outDelta;
    const msg = e.message || {};
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'tool_use') {
        const target = toolTarget(b.name, b.input);
        sub.tool = target ? `${b.name} · ${target}` : b.name;
      }
    }
    if (msg.stop_reason === 'end_turn') sub.done = true;
  }

  // ---------- read side ----------

  statusOf(s, now = this.now()) {
    const subActive = [...s.subagents.values()].some(a => !a.hidden && !a.done && a.lastActivity && now - a.lastActivity < STALE_AFTER_MS);
    return phaseStatus(s.phase, s.lastMainActivity, subActive, now);
  }

  summarize(s, now = this.now()) {
    const status = this.statusOf(s, now);
    const { usd: estimated, unknownModels, totals, byModel } = estimate(s.usageByModel);
    // cost-state is only written when Claude Code exits, so add what we've seen since.
    const sinceReport = s.reportedCost == null ? 0 : Math.max(0, estimated - s.estimatedAtReport);
    const ctxWindow = contextWindow(s.model);

    const subagents = [...s.subagents.values()]
      .filter(a => !a.hidden)
      .map(a => ({
        id: a.id,
        type: a.type,
        description: a.description,
        tool: a.tool,
        outputTokens: a.outputTokens,
        startedAt: a.startedAt,
        lastActivity: a.lastActivity,
        status: a.done || status === 'ended' ? 'done'
          : a.lastActivity && now - a.lastActivity < STALE_AFTER_MS ? 'running' : 'stale',
      }))
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));

    const pending = [...s.pendingTools.values()].at(-1) || null;
    const parts = s.cwd.split(/[\\/]/).filter(Boolean);

    return {
      id: s.id,
      cwd: s.cwd,
      project: parts.slice(-2).join('/') || s.id.slice(0, 8),
      title: s.title || s.agentName || '',
      gitBranch: s.gitBranch,
      version: s.version,
      entrypoint: s.entrypoint,
      permissionMode: s.permissionMode,
      model: s.model,
      status,
      phaseSince: s.phaseSince,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
      currentTool: pending && (status === 'tool' || status === 'question' || status === 'stale')
        ? { name: pending.name, target: pending.target, since: pending.at } : null,
      error: status === 'error' ? s.error : null,
      summary: s.summary,
      lastPrompt: s.lastPrompt,
      turns: s.turns,
      apiCalls: s.apiCalls,
      compactions: s.compactions,
      context: { tokens: s.contextTokens, window: ctxWindow, pct: Math.min(100, (s.contextTokens / ctxWindow) * 100) },
      tokens: totals,
      byModel,
      cost: {
        usd: s.reportedCost == null ? estimated : s.reportedCost + sinceReport,
        source: s.reportedCost == null ? 'estimate' : sinceReport > 0.0005 ? 'claude-code+estimate' : 'claude-code',
        estimated,
        reported: s.reportedCost,
        unknownModels,
      },
      spendByDay: Object.fromEntries(s.spendByDay),
      forkedFrom: s.forkedFrom,
      linesAdded: s.linesAdded,
      linesRemoved: s.linesRemoved,
      subagents,
      files: s.files,
      log: s.log,
    };
  }

  snapshot(now = this.now()) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (!s.startedAt) continue; // only metadata seen so far
      out.push(this.summarize(s, now));
    }
    return out;
  }

  /** Drop sessions with no activity since `cutoff` (ms). */
  prune(cutoff) {
    for (const [id, s] of this.sessions) {
      if ((s.lastActivity || 0) < cutoff) this.sessions.delete(id);
    }
    for (const [uuid, id] of this.owners) if (!this.sessions.has(id)) this.owners.delete(uuid);
  }
}
