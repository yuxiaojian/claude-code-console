// PA screen: one folder's sessions on the left, the selected session on the right.
import { MODES, SPEND_NOTE, STATUS, ago, api, dot, editable, h, home, modeLabel, paHref, render, select, sessionName, shortModel, state, usd } from './core.js';
import { chatBox } from './chat.js';
import { costTitle, sessionPane } from './session.js';

const URGENCY = ['approval', 'question', 'error', 'waiting', 'tool', 'working', 'stale', 'idle', 'ended'];
const GROUPS = [
  ['Needs you', s => STATUS[s.status].group === 'needs'],
  ['Working', s => STATUS[s.status].group === 'active'],
  ['Recent', s => STATUS[s.status].group === 'recent'],
];

const patch = (p, body) => api('PATCH', `/api/pas/${p.id}`, body);

function header(p) {
  return h('div', { class: 'pa-head' },
    h('div', { class: 'row spread' },
      h('div', { class: 'row' },
        dot(p.status),
        editable(p.name, { cls: 'pa-title', title: 'Click to rename', save: name => patch(p, { name }) }),
        h('button', { class: 'btn icon', title: p.pinned ? 'Unpin' : 'Pin to the top', onclick: () => patch(p, { pinned: !p.pinned }).catch(err => alert(err.message)) },
          p.pinned ? '★' : '☆'),
      ),
      h('div', { class: 'row' },
        h('span', { class: 'quiet', title: SPEND_NOTE }, h('b', null, usd(p.spend.today)), ' today · ',
          h('b', null, usd(p.spend.period)), ` last ${state.totals?.days ?? 7} days`),
        state.chat ? h('button', { class: `btn${state.settingsOpen === p.id ? ' on' : ''}`, title: 'Model and permission mode for sessions the console starts here',
          onclick: () => { state.settingsOpen = state.settingsOpen === p.id ? null : p.id; render(); } }, '⚙ Defaults') : null,
        h('button', { class: 'btn', onclick: () => patch(p, { hidden: !p.hidden }).catch(err => alert(err.message)) }, p.hidden ? 'Unhide' : 'Hide'),
        p.added && !p.counts.sessions ? h('button', { class: 'btn', onclick: () => remove(p) }, 'Remove') : null,
      ),
    ),
    h('div', { class: 'row' },
      h('div', { class: 'where' },
        p.root ? h('a', { title: `Open ${p.root}`, onclick: () => api('POST', `/api/pas/${p.id}/open`).catch(err => alert(err.message)) }, home(p.root)) : '—'),
      p.model || p.permissionMode ? h('span', { class: 'badge mode', title: 'Defaults for sessions the console starts here' },
        [p.model && shortModel(p.model), p.permissionMode && modeLabel(p.permissionMode)].filter(Boolean).join(' · ')) : null,
    ),
    state.settingsOpen === p.id ? defaults(p) : null,
  );
}

/** Per-PA defaults for console-started sessions. Terminal sessions keep their own settings. */
function defaults(p) {
  const models = [...new Set(['opus', 'sonnet', 'haiku', ...p.models, p.model].filter(Boolean))];
  const save = body => patch(p, body).catch(err => alert(err.message));
  return h('div', { class: 'defaults' },
    h('label', null, 'Model',
      select([['', 'Your Claude Code default'], ...models.map(m => [m, m])], p.model, model => save({ model }))),
    h('label', null, 'Permission mode',
      select([['', 'Ask before tools (default)'], ...MODES.filter(([k]) => k !== 'default')], p.permissionMode, permissionMode => save({ permissionMode }))),
    h('span', { class: 'quiet small' }, 'Used when the console starts, resumes or forks a session in this folder. Your permission rules still apply.'),
  );
}

async function remove(p) {
  try { await api('DELETE', `/api/pas/${p.id}`); location.hash = '#/'; } catch (err) { alert(err.message); }
}

function newSessionLink(p, selected) {
  if (!state.chat || !p.root) return null;
  return h('a', { class: `srow new${selected === 'new' ? ' selected' : ''}`, href: paHref(p.id, 'new') }, h('span', { class: 'glyph' }, '+'), h('span', { class: 'name' }, 'New session'));
}

function newSessionPane(p) {
  return h('div', { class: 'session' },
    h('div', { class: 'session-head' }, h('h2', { class: 'title' }, 'New session'), h('div', { class: 'where pad-b' }, home(p.root))),
    h('div', { class: 'conv' }, h('p', { class: 'quiet conv-status' },
      state.pending?.pa === p.id ? 'Starting Claude Code…' : `Claude Code will start in ${home(p.root)} with your usual settings, and ask here before running tools.`)),
    chatBox({ pa: p }),
  );
}

function sessionList(p, sessions, selected) {
  const q = state.filter.toLowerCase();
  const shown = q ? sessions.filter(s => [sessionName(s), s.gitBranch, s.model, s.lastPrompt].some(v => v?.toLowerCase().includes(q))) : sessions;
  if (!sessions.length) return h('div', { class: 'quiet pad' }, 'No sessions in the loaded window.');
  if (!shown.length) return h('div', { class: 'quiet pad' }, 'No sessions match the filter.');
  return GROUPS.map(([title, test]) => {
    const list = shown.filter(test);
    if (!list.length) return null;
    return [
      h('div', { class: 'group' }, title, h('span', null, list.length)),
      list.map(s => h('a', { class: `srow s-${s.status}${s.id === selected ? ' selected' : ''}`, href: paHref(p.id, s.id), title: sessionName(s) },
        dot(s.status),
        h('span', { class: 'name' }, sessionName(s)),
        h('span', { class: 'meta' },
          h('span', { title: costTitle(s.cost) }, usd(s.cost.usd)),
          h('span', null, ago(s.lastActivity)),
        ),
        s.gitBranch && s.gitBranch !== 'HEAD' ? h('span', { class: 'branch small' }, s.gitBranch) : null,
      )),
    ];
  });
}

export function paView(main, r) {
  const p = state.projects.find(x => x.id === r.pa);
  if (!p) {
    main.replaceChildren(h('p', { class: 'empty' }, state.totals ? 'This assistant is gone. ' : 'Loading…',
      state.totals ? h('a', { href: '#/' }, 'Back to overview') : null));
    return;
  }
  const sessions = state.sessions.filter(s => s.pa === p.id)
    .sort((a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.lastActivity || 0) - (a.lastActivity || 0));
  let selected = r.isNew || (!r.session && !sessions.length && state.chat && p.root) ? 'new' : r.session;
  if (!selected && sessions.length) {
    selected = sessions[0].id;
    history.replaceState(null, '', paHref(p.id, selected)); // no extra history entry, so Back still works
  }
  const s = sessions.find(x => x.id === selected);

  main.replaceChildren(h('div', { class: 'pa' },
    header(p),
    h('div', { class: 'pa-body' },
      h('nav', { class: 'sessions', 'data-scroll': `sessions:${p.id}` }, newSessionLink(p, selected), sessionList(p, sessions, selected)),
      h('div', { class: 'pane' },
        selected === 'new' ? newSessionPane(p)
          : s ? sessionPane(s) : h('p', { class: 'empty' }, sessions.length ? 'That session is no longer loaded.' : 'No sessions yet.')),
    ),
  ));
}

