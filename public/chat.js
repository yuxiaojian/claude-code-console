// Talking to a session: approval requests, the message box, Stop and Fork.
// One box per session (or per new-session screen) is kept alive across re-renders,
// so a half-typed message and the cursor survive live updates.
import { CODEX_MODES, MODES, POLICY_NOTE, api, h, home, paHref, providerName, render, select, state } from './core.js';
import { markdown } from './markdown.js';
import { codexCard } from './codex-cards.js';

const boxes = new Map();
const KEEP_BOXES = 8;

/** The latest console run for a session, or for a pending key. */
export const runFor = (sessionId, key) =>
  state.runs.filter(r => (key && r.key === key) || (sessionId && r.sessionId === sessionId)).at(-1) || null;

/** `target` is { session } for an existing session or { pa, provider } for a new one. */
export function chatBox(target) {
  const id = target.session ? `s:${target.session.id}` : `new:${target.pa.id}:${target.provider || 'claude'}`;
  let box = boxes.get(id);
  if (!box) {
    box = new ChatBox(target);
    boxes.set(id, box);
    if (boxes.size > KEEP_BOXES) boxes.delete(boxes.keys().next().value);
  }
  box.target = target;
  box.update();
  return box.el;
}

/** After a fork or a new session starts, open it once its transcript appears. */
export function followPending() {
  const p = state.pending;
  if (!p) return;
  const run = state.runs.find(r => r.key === p.key);
  if (!run) return;
  const s = run.sessionId && state.sessions.find(x => x.id === run.sessionId);
  if (s) {
    state.pending = null;
    history.replaceState(null, '', paHref(s.pa, s.id));
  } else if (run.state === 'closed') {
    state.pending = null;
  }
}

class ChatBox {
  constructor(target) {
    this.target = target;
    this.forking = false;
    this.sending = false;
    this.error = '';
    this.approvalsKey = '';

    this.approvals = h('div', { class: 'approvals' });
    this.notice = h('div', { class: 'chat-notice' });
    this.input = h('textarea', { rows: '1', 'data-keep-focus': '1', placeholder: 'Message Claude…' });
    this.sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
    this.stopBtn = h('button', { class: 'btn', type: 'button', title: 'Interrupt the current turn', onclick: () => this.stop() }, '■ Stop');
    this.status = h('div', { class: 'chat-status small' });
    this.mode = null; // the user's pick; until then, follow the run or the PA default
    this.modeSlot = h('span', { class: 'mode-slot' });
    this.form = h('form', { class: 'composer' }, this.input, h('div', { class: 'composer-actions' }, this.modeSlot, this.stopBtn, this.sendBtn));
    this.el = h('div', { class: 'chat' }, this.approvals, this.notice, this.form, this.status);

    this.form.addEventListener('submit', e => { e.preventDefault(); this.send(); });
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
    });
    this.input.addEventListener('input', () => this.#grow());
    this.input.addEventListener('compositionstart', () => { state.composing = true; });
    this.input.addEventListener('compositionend', () => { state.composing = false; });
  }

  #grow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }

  get run() {
    const s = this.target.session;
    return s ? runFor(s.id) : state.pending?.pa === this.target.pa.id ? runFor(null, state.pending.key) : null;
  }

  get provider() { return this.target.session?.provider || this.target.provider || 'claude'; }

  update() {
    const s = this.target.session;
    const run = this.run;
    const live = run && run.state !== 'closed';
    const inTerminal = s?.openIn === 'terminal';
    const codex = this.provider === 'codex';
    const who = providerName(this.provider);
    const available = state.providers[this.provider] || { chat: false };

    this.#renderApprovals(live ? run : null);

    // What the box can do right now.
    let notice = null;
    if (!available.chat) {
      notice = codex ? [available.reason || 'Chat for Codex is unavailable.']
        : ['Chat is off because the Claude Agent SDK isn’t installed. Run ', h('code', null, 'npm install'), ' and restart the console.'];
    } else if (codex && s && !s.canContinue && !this.forking) {
      // Only a run the console holds can be continued; everything else forks.
      const where = s.openIn === 'external' ? ' Another Codex process has it open.'
        : s.openIn === 'unknown' ? ' The console couldn’t check whether another Codex process has it open.' : '';
      notice = [
        h('span', null, `The console isn’t running this Codex session, so it can’t continue it.${where} A fork continues from the same history in a new session.`),
        h('button', { class: 'btn', type: 'button', onclick: () => { this.forking = true; this.update(); this.input.focus(); } }, 'Fork and continue here'),
      ];
    } else if (inTerminal && !this.forking) {
      notice = [
        h('span', null, `This session is open in a terminal${s.terminalStatus ? ` (${s.terminalStatus})` : ''}. Sending here would mix two conversations into one transcript.`),
        h('button', { class: 'btn', type: 'button', onclick: () => { this.forking = true; this.update(); this.input.focus(); } }, 'Fork and continue here'),
      ];
    }
    this.notice.replaceChildren(...(notice ? [h('div', { class: 'notice-row' }, notice)] : []));
    this.notice.hidden = !notice;
    this.form.hidden = Boolean(notice);

    const starting = state.pending && (!s || state.pending.from === s.id);
    this.input.placeholder = !s ? `Start a new ${who} session in ${home(this.target.pa.root)}…`
      : this.forking ? 'Message a fork of this session…'
      : live ? `Message ${who}… (Enter to send, Shift+Enter for a new line)`
      : `Message ${who} to resume this session…`;
    this.stopBtn.hidden = !(live && ['running', 'starting'].includes(run.state));
    this.sendBtn.disabled = this.sending;
    const pa = state.projects.find(x => x.id === (s ? s.pa : this.target.pa.id));
    const mode = this.mode || (live ? run.mode : codex ? pa?.codexMode : pa?.permissionMode) || (codex ? 'workspace' : 'default');
    if (this.modeSlot.dataset.value !== mode) {
      this.modeSlot.dataset.value = mode;
      this.modeSlot.replaceChildren(codex
        ? select(CODEX_MODES, mode, m => this.setMode(m), { class: 'mode-pick', title: POLICY_NOTE })
        : select(MODES, mode, m => this.setMode(m), { class: 'mode-pick', title: 'Permission mode for this session' }));
    }
    this.sendBtn.textContent = this.forking ? 'Fork & send' : 'Send';

    const app = codex ? 'Codex' : 'Claude Code';
    const parts = [];
    if (this.error) parts.push(h('span', { class: 'err' }, this.error));
    else if (run?.error) parts.push(h('span', { class: 'err' }, codex ? run.error : `Claude Code: ${run.error}`));
    if (starting) parts.push(h('span', { class: 'quiet' }, `Starting ${app}…`));
    else if (live) {
      parts.push(h('span', { class: 'quiet' }, run.state === 'idle' ? 'Connected · idle' : run.state === 'starting' ? `Starting ${app}…` : 'Connected · working'),
        codex && run.policy ? h('span', { class: 'quiet', title: POLICY_NOTE }, ` · ${run.policy.approval} · ${run.policy.sandbox}${run.policy.requested ? ' (requested)' : ''}${run.modePending ? ` · ${run.mode} from the next turn` : ''}`) : null,
        codex && run.notice ? h('span', { class: 'err' }, ` ${run.notice}`) : null,
        h('button', { class: 'more', type: 'button', title: `End the ${app} process the console started for this session`, onclick: () => this.release(run) }, 'Disconnect'));
    }
    this.status.replaceChildren(...parts);
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || this.sending) return;
    const s = this.target.session;
    this.sending = true;
    this.error = '';
    this.update();
    try {
      if (!s) {
        const { key } = await api('POST', `/api/pas/${this.target.pa.id}/sessions`, { text, provider: this.provider, permissionMode: this.modeSlot.dataset.value });
        state.pending = { key, pa: this.target.pa.id };
      } else if (this.forking) {
        const { key } = await api('POST', `/api/sessions/${s.id}/fork`, { text, permissionMode: this.modeSlot.dataset.value });
        state.pending = { key, pa: s.pa, from: s.id };
        this.forking = false;
      } else {
        await api('POST', `/api/sessions/${s.id}/messages`, { text, permissionMode: this.modeSlot.dataset.value });
      }
      this.input.value = '';
      this.#grow();
    } catch (err) {
      this.error = err.message;
    }
    this.sending = false;
    render();
  }

  async setMode(mode) {
    this.mode = mode;
    const run = this.run;
    if (run && run.state !== 'closed') {
      try { await api('POST', `/api/runs/${run.key}/mode`, { mode }); } catch (err) { this.error = err.message; }
    }
    render();
  }

  async stop() {
    try { await api('POST', `/api/sessions/${this.target.session.id}/interrupt`); } catch (err) { this.error = err.message; render(); }
  }

  async release(run) {
    try { await api('POST', `/api/runs/${run.key}/close`); } catch (err) { this.error = err.message; render(); }
  }

  #renderApprovals(run) {
    const list = run?.approvals || [];
    const key = run ? `${run.key}:${list.map(a => a.id).join(',')}` : '';
    if (key === this.approvalsKey) return; // keep cards (and anything typed in them) as they are
    this.approvalsKey = key;
    this.approvals.replaceChildren(...list.map(a => (run.provider === 'codex' ? codexCard(run, a, decide) : approvalCard(run, a))));
  }
}

// ---------- approval cards ----------
async function decide(run, a, body, card) {
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  try {
    await api('POST', `/api/runs/${run.key}/approvals/${encodeURIComponent(a.id)}`, body);
  } catch (err) {
    card.querySelector('.approval-error').textContent = err.message;
    for (const b of card.querySelectorAll('button')) b.disabled = false;
  }
}

function kv(input) {
  return h('table', { class: 'kv' }, Object.entries(input).map(([k, v]) =>
    h('tr', null, h('th', null, k), h('td', null, typeof v === 'string' ? v : JSON.stringify(v, null, 2)))));
}

function preview(a) {
  const i = a.input;
  switch (a.tool) {
    case 'Bash':
      return [i.description ? h('div', { class: 'quiet' }, i.description) : null, h('pre', { class: 'cmd' }, `$ ${i.command || ''}`)];
    case 'Edit':
      return [h('div', { class: 'where' }, i.file_path || ''),
        h('div', { class: 'diff' }, h('table', null,
          ...String(i.old_string ?? '').split('\n').map(l => h('tr', { class: 'del' }, h('td', { class: 'src' }, `-${l}`))),
          ...String(i.new_string ?? '').split('\n').map(l => h('tr', { class: 'add' }, h('td', { class: 'src' }, `+${l}`)))))];
    case 'Write':
      return [h('div', { class: 'where' }, i.file_path || ''), h('pre', { class: 'out' }, i.content || '')];
    default: {
      const { plan, questions, ...rest } = i;
      return Object.keys(rest).length ? kv(rest) : null;
    }
  }
}

function question(a, run, card) {
  const picked = new Map(); // question -> Set(labels)
  const other = new Map();
  const qs = Array.isArray(a.input.questions) ? a.input.questions : [];
  const blocks = qs.map(q => {
    picked.set(q.question, new Set());
    const opts = (q.options || []).map(o => {
      const btn = h('button', { class: 'option', type: 'button', title: o.description || '' },
        h('b', null, o.label), o.description ? h('span', { class: 'quiet' }, o.description) : null);
      btn.addEventListener('click', () => {
        const set = picked.get(q.question);
        if (!q.multiSelect) { set.clear(); for (const b of btn.parentNode.children) b.classList.remove('on'); }
        if (set.has(o.label)) { set.delete(o.label); btn.classList.remove('on'); } else { set.add(o.label); btn.classList.add('on'); }
      });
      return btn;
    });
    const free = h('input', { type: 'text', placeholder: 'Or type your own answer', 'data-keep-focus': '1' });
    other.set(q.question, free);
    return h('div', { class: 'question' },
      q.header ? h('span', { class: 'chip q-head' }, q.header) : null,
      h('div', { class: 'q-text' }, q.question, q.multiSelect ? h('span', { class: 'quiet' }, ' (pick any)') : null),
      h('div', { class: 'options' }, opts), free);
  });
  const submit = () => {
    const answers = {};
    for (const q of qs) {
      const typed = other.get(q.question).value.trim();
      const chosen = [...picked.get(q.question)];
      if (typed) chosen.push(typed);
      if (chosen.length) answers[q.question] = chosen.join(', ');
    }
    if (Object.keys(answers).length < qs.length) {
      card.querySelector('.approval-error').textContent = 'Answer every question first.';
      return;
    }
    decide(run, a, { allow: true, answers }, card);
  };
  return [blocks, h('div', { class: 'approval-actions' },
    h('button', { class: 'btn', type: 'button', onclick: () => decide(run, a, { allow: false, message: 'The user declined to answer.' }, card) }, 'Skip'),
    h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Send answers'))];
}

function approvalCard(run, a) {
  const card = h('div', { class: 'approval' });
  const reason = h('input', { type: 'text', placeholder: 'Tell Claude what to do instead (optional)', 'data-keep-focus': '1' });
  const deny = label => h('button', { class: `btn${a.defaultToNo ? ' primary' : ''}`, type: 'button',
    onclick: () => decide(run, a, { allow: false, message: reason.value }, card) }, label);

  let body, actions;
  if (a.tool === 'AskUserQuestion') {
    body = question(a, run, card);
  } else if (a.tool === 'ExitPlanMode') {
    body = h('div', { class: 'md plan' }, markdown(String(a.input.plan || '')));
    actions = [reason, deny('Keep planning'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => decide(run, a, { allow: true }, card) }, 'Approve plan')];
  } else {
    body = preview(a);
    actions = [reason, deny('Deny'),
      a.canAlways ? h('button', { class: 'btn', type: 'button', title: 'Allow, and don’t ask again for this kind of action in this session',
        onclick: () => decide(run, a, { allow: true, always: true }, card) }, 'Always allow') : null,
      h('button', { class: `btn${a.defaultToNo ? '' : ' primary'}`, type: 'button', onclick: () => decide(run, a, { allow: true }, card) }, 'Allow')];
  }
  const title = a.tool === 'AskUserQuestion' ? 'Claude has a question'
    : a.tool === 'ExitPlanMode' ? 'Claude has a plan for you to review'
    : a.title || `Claude wants to use ${a.displayName}${a.description ? `: ${a.description}` : ''}`;
  card.append(...[
    h('div', { class: 'approval-title' }, title),
    a.reason ? h('div', { class: 'quiet small' }, a.reason) : null,
    a.blockedPath ? h('div', { class: 'quiet small' }, `Outside the allowed folders: ${a.blockedPath}`) : null,
    h('div', { class: 'approval-body' }, body),
    actions ? h('div', { class: 'approval-actions' }, actions) : null,
    h('div', { class: 'approval-error err small' }),
  ].filter(Boolean)); // Element.append would print null as text
  return card;
}
