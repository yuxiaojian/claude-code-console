// Codex's own approval and question requests. Each card offers exactly the decisions the
// request offered; a decision that saves a rule for future sessions says so on its button.
import { h } from './core.js';

function diff(d) {
  if (!d?.hunks?.length) return null;
  const rows = [];
  for (const hk of d.hunks) {
    if (rows.length) rows.push(h('tr', { class: 'gap' }, h('td', { class: 'src' }, '⋯')));
    for (const l of hk.lines) rows.push(h('tr', { class: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'same' }, h('td', { class: 'src' }, l)));
  }
  return h('div', { class: 'diff' }, h('table', null, rows), d.truncated ? h('div', { class: 'quiet small' }, 'Diff truncated') : null);
}

function buttons(run, a, card, decide) {
  return a.decisions.map((d, i) => h('button', {
    class: `btn${i === 0 ? ' primary' : ''}${d.persistent ? ' persistent' : ''}`, type: 'button',
    title: d.persistent ? 'Saved to your Codex rules: applies to future sessions too' : '',
    onclick: () => decide(run, a, { decision: d.id }, card),
  }, d.label));
}

function questions(run, a, card, decide) {
  const fields = a.questions.map(q => {
    const picked = new Set();
    const opts = q.options.map(o => {
      const btn = h('button', { class: 'option', type: 'button', title: o.description || '' },
        h('b', null, o.label), o.description ? h('span', { class: 'quiet' }, o.description) : null);
      btn.addEventListener('click', () => {
        picked.clear();
        for (const b of btn.parentNode.children) b.classList.remove('on');
        picked.add(o.label);
        btn.classList.add('on');
      });
      return btn;
    });
    // A secret answer is typed into a password field and only ever sent to Codex.
    const free = q.isOther || q.isSecret || !q.options.length
      ? h('input', { type: q.isSecret ? 'password' : 'text', autocomplete: 'off', placeholder: q.isSecret ? 'Secret answer' : 'Type your answer', 'data-keep-focus': '1' })
      : null;
    return {
      q, picked, free,
      el: h('div', { class: 'question' },
        q.header ? h('span', { class: 'chip q-head' }, q.header) : null,
        h('div', { class: 'q-text' }, q.question),
        opts.length ? h('div', { class: 'options' }, opts) : null, free),
    };
  });
  const submit = () => {
    const answers = {};
    for (const f of fields) {
      const typed = f.free?.value.trim();
      const list = typed ? [typed] : [...f.picked];
      if (!list.length) { card.querySelector('.approval-error').textContent = 'Answer every question first.'; return; }
      answers[f.q.id] = list;
    }
    decide(run, a, { answers }, card);
  };
  return [fields.map(f => f.el), h('div', { class: 'approval-actions' },
    h('button', { class: 'btn', type: 'button', onclick: () => decide(run, a, { decision: 'skip' }, card) }, 'Skip'),
    h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Send answers'))];
}

const TITLES = {
  command: 'Codex wants to run a command',
  fileChange: 'Codex wants to change files',
  permissions: 'Codex is asking for more permissions',
  question: 'Codex has a question',
};

export function codexCard(run, a, decide) {
  const card = h('div', { class: 'approval' });
  let body = null, actions = null;
  switch (a.kind) {
    case 'command':
      body = [h('pre', { class: 'cmd' }, `$ ${a.command || ''}`), a.cwd ? h('div', { class: 'where' }, a.cwd) : null];
      actions = buttons(run, a, card, decide);
      break;
    case 'fileChange':
      body = a.files?.length ? a.files.map(f => [h('div', { class: 'where' }, f.path), diff(f.diff)])
        : h('div', { class: 'quiet small' }, 'The console didn’t receive the details of this change.');
      if (a.grantRoot) body = [body, h('div', { class: 'quiet small' }, `Also asks to allow writes under ${a.grantRoot} for this session`)];
      actions = buttons(run, a, card, decide);
      break;
    case 'permissions':
      body = h('pre', { class: 'out' }, JSON.stringify(a.permissions, null, 2));
      actions = buttons(run, a, card, decide);
      break;
    case 'question':
      body = questions(run, a, card, decide);
      break;
    case 'elicitation':
      body = [a.message ? h('div', null, a.message) : null,
        h('div', { class: 'quiet small' }, 'The console can’t fill in MCP server forms. Decline or cancel here, or answer from a Codex terminal session.')];
      actions = buttons(run, a, card, decide);
      break;
    default:
      body = h('div', { class: 'quiet small' }, 'Codex is waiting on a request the console can’t show.');
  }
  card.append(...[
    h('div', { class: 'approval-title' }, a.kind === 'elicitation' ? `${a.serverName || 'An MCP server'} is asking for input` : TITLES[a.kind] || 'Codex is waiting for you'),
    a.reason ? h('div', { class: 'quiet small' }, a.reason) : null,
    h('div', { class: 'approval-body' }, body),
    actions ? h('div', { class: 'approval-actions' }, actions) : null,
    h('div', { class: 'approval-error err small' }),
  ].filter(Boolean));
  return card;
}
