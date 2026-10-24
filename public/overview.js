// Overview: what needs you across every PA, and one small card per PA.
import { NEEDS, SPEND_NOTE, STATUS, ago, dot, h, home, paHref, sessionName, state, usd } from './core.js';

const URGENCY = ['question', 'error', 'waiting'];

function stats(t) {
  const stat = (label, value, extra = {}) => h('div', { class: `stat ${extra.cls || ''}`, title: extra.title },
    h('span', { class: 'v' }, value), h('span', { class: 'k' }, label));
  return h('div', { class: 'stats-strip' },
    stat('need you', t.needs, { cls: t.needs ? 'needs' : '' }),
    stat('working', t.active),
    stat('today', usd(t.today), { title: SPEND_NOTE }),
    stat(`last ${t.days} days`, usd(t.period), { title: SPEND_NOTE }),
    stat('sessions', t.sessions),
  );
}

function needsQueue(sessions, byId) {
  const rows = sessions
    .filter(s => NEEDS.has(s.status) && !byId.get(s.pa)?.hidden)
    .sort((a, b) => URGENCY.indexOf(a.status) - URGENCY.indexOf(b.status) || (b.phaseSince || 0) - (a.phaseSince || 0));
  if (!rows.length) return h('section', { class: 'section' }, h('h2', null, 'Needs you'), h('p', { class: 'quiet' }, 'Nothing is waiting on you.'));
  return h('section', { class: 'section' },
    h('h2', null, 'Needs you', h('span', null, rows.length)),
    h('div', { class: 'list' }, rows.map(s => h('a', { class: 'queue-row', href: paHref(s.pa, s.id) },
      dot(s.status),
      h('span', { class: 'pa-name' }, byId.get(s.pa)?.name || s.project),
      h('span', { class: 'name' }, sessionName(s),
        s.status === 'error' && s.error ? h('span', { class: 'sub-text err' }, s.error.message)
          : s.summary ? h('span', { class: 'sub-text' }, s.summary) : null),
      h('span', { class: `pill s-${s.status}` }, STATUS[s.status].label),
      h('span', { class: 'num' }, ago(s.phaseSince || s.lastActivity)),
    ))),
  );
}

function paCard(p) {
  const chips = [
    p.counts.needs ? h('span', { class: 'chip s-waiting' }, `${p.counts.needs} need${p.counts.needs === 1 ? 's' : ''} you`) : null,
    p.counts.active ? h('span', { class: 'chip s-working' }, `${p.counts.active} working`) : null,
  ];
  return h('a', { class: `pa-card s-${p.status}${p.hidden ? ' hidden' : ''}`, href: paHref(p.id) },
    h('div', { class: 'row spread' },
      h('div', { class: 'row' }, dot(p.status), h('span', { class: 'title' }, p.name), p.pinned ? h('span', { class: 'pin', title: 'Pinned' }, '★') : null),
      p.spend.today >= 0.005
        ? h('span', { class: 'num', title: SPEND_NOTE }, usd(p.spend.today), h('span', { class: 'quiet' }, ' today'))
        : h('span', { class: 'num quiet', title: SPEND_NOTE }, p.spend.period >= 0.005 ? `${usd(p.spend.period)} · ${state.totals?.days ?? 7}d` : ''),
    ),
    h('div', { class: 'where' }, p.root ? home(p.root) : '—'),
    h('div', { class: 'row chips' }, chips,
      h('span', { class: 'quiet' }, `${p.counts.sessions} session${p.counts.sessions === 1 ? '' : 's'}`,
        p.lastActivity ? ` · ${ago(p.lastActivity)} ago` : '')),
    p.latest?.title ? h('div', { class: 'prompt', title: p.latest.title }, p.latest.title) : h('div', { class: 'prompt quiet' }, 'No recent sessions'),
  );
}

export function overview(main) {
  const q = state.filter.toLowerCase();
  const byId = new Map(state.projects.map(p => [p.id, p]));
  const match = p => !q || [p.name, p.root, p.latest?.title].some(v => v?.toLowerCase().includes(q));
  const visible = state.projects.filter(p => !p.hidden && match(p));
  const hidden = state.projects.filter(p => p.hidden && match(p));
  const sessions = q ? state.sessions.filter(s => match(byId.get(s.pa) || {}) || sessionName(s).toLowerCase().includes(q)) : state.sessions;

  main.replaceChildren(h('div', { class: 'overview' },
    state.totals ? stats(state.totals) : null,
    needsQueue(sessions, byId),
    h('section', { class: 'section' },
      h('h2', null, 'Assistants', h('span', null, visible.length)),
      visible.length ? h('div', { class: 'pa-grid' }, visible.map(paCard))
        : h('p', { class: 'quiet' }, state.projects.length ? 'No assistants match the filter.' : 'No Claude Code sessions found yet. Start one in any terminal, or add a folder.'),
    ),
    hidden.length ? h('section', { class: 'section' },
      h('button', { class: 'more', onclick: () => { state.showHidden = !state.showHidden; overview(main); } },
        `${state.showHidden ? '▾' : '▸'} Hidden (${hidden.length})`),
      state.showHidden ? h('div', { class: 'pa-grid' }, hidden.map(paCard)) : null,
    ) : null,
  ));
}
