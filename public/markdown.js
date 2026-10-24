// A small Markdown renderer for Claude's replies. It builds DOM nodes directly (never
// innerHTML), so transcript text can't inject markup. Covers what Claude writes most:
// paragraphs, headings, lists (nested, task lists), code blocks, tables, quotes, rules,
// and inline code, bold, italic and links.
import { h } from './core.js';

const SAFE_URL = /^(https?:|mailto:)/i;
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"`\]])/g;

function link(text, href) {
  return SAFE_URL.test(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text;
}

export function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] != null) out.push(h('code', null, m[2]));
    else if (m[3] != null) out.push(SAFE_URL.test(m[4]) ? link(inline(m[3]), m[4]) : m[0]); // unsafe links stay as text
    else if (m[5] != null || m[6] != null) out.push(h('strong', null, inline(m[5] ?? m[6])));
    else if (m[7] != null) out.push(h('em', null, inline(m[7])));
    else if (m[8] != null) out.push(link(m[8], m[8]));
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Paragraph text keeps single line breaks, as Claude uses them on purpose. */
function lines(text) {
  return text.split('\n').flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)));
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const startsBlock = (l, next) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || LIST.test(l) || QUOTE.test(l)
  || (l.includes('|') && next != null && TABLE_SEP.test(next));

const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

function list(items) {
  // items: [{ indent, ordered, text, start }]; nesting follows indentation.
  const root = items[0];
  const el = h(root.ordered ? 'ol' : 'ul', root.ordered && root.start !== 1 ? { start: String(root.start) } : null);
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const task = it.text.match(/^\[([ xX])\]\s+(.*)$/s);
    const li = h('li', task ? { class: 'task' } : null, task ? [task[1] === ' ' ? '☐ ' : '☑ ', lines(task[2])] : lines(it.text));
    let j = i + 1;
    while (j < items.length && items[j].indent > it.indent) j++;
    if (j > i + 1) li.append(list(items.slice(i + 1, j)));
    el.append(li);
    i = j;
  }
  return el;
}

export function markdown(src) {
  const ls = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (!l.trim()) { i++; continue; }

    const fence = l.match(FENCE);
    if (fence) {
      const body = [];
      i++;
      while (i < ls.length && !ls[i].trim().startsWith(fence[1])) body.push(ls[i++]);
      i++;
      out.push(h('pre', { class: 'code', 'data-lang': fence[2] || null }, h('code', null, body.join('\n'))));
      continue;
    }
    const head = l.match(HEADING);
    if (head) {
      out.push(h(head[1].length === 1 ? 'h4' : head[1].length === 2 ? 'h5' : 'h6', null, inline(head[2])));
      i++;
      continue;
    }
    if (RULE.test(l)) { out.push(h('hr')); i++; continue; }

    if (l.includes('|') && i + 1 < ls.length && TABLE_SEP.test(ls[i + 1])) {
      const header = cells(l);
      const align = cells(ls[i + 1]).map(c => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : null));
      i += 2;
      const rows = [];
      while (i < ls.length && ls[i].includes('|') && ls[i].trim()) rows.push(cells(ls[i++]));
      const td = (tag, c, k) => h(tag, align[k] ? { style: `text-align:${align[k]}` } : null, inline(c));
      out.push(h('div', { class: 'table-wrap' }, h('table', { class: 'md' },
        h('thead', null, h('tr', null, header.map((c, k) => td('th', c, k)))),
        h('tbody', null, rows.map(r => h('tr', null, header.map((_, k) => td('td', r[k] ?? '', k))))),
      )));
      continue;
    }
    if (QUOTE.test(l)) {
      const body = [];
      while (i < ls.length && QUOTE.test(ls[i])) body.push(ls[i++].replace(QUOTE, ''));
      out.push(h('blockquote', null, markdown(body.join('\n'))));
      continue;
    }
    if (LIST.test(l)) {
      const items = [];
      while (i < ls.length) {
        const m = ls[i].match(LIST);
        if (m) {
          const ordered = /\d/.test(m[2]);
          if (items.length && m[1].length <= items[0].indent && ordered !== items[0].ordered) break; // a new kind of list
          items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] });
          i++;
        } else if (ls[i].trim() && /^\s+/.test(ls[i]) && items.length) {
          items.at(-1).text += '\n' + ls[i++].trim(); // continuation of the previous item
        } else if (!ls[i].trim() && i + 1 < ls.length && (LIST.test(ls[i + 1]) || /^\s+\S/.test(ls[i + 1]))) {
          i++; // blank line inside a loose list
        } else break;
      }
      out.push(list(items));
      continue;
    }
    const para = [];
    while (i < ls.length && ls[i].trim() && !(para.length && startsBlock(ls[i], ls[i + 1]))) para.push(ls[i++]);
    out.push(h('p', null, lines(para.join('\n'))));
  }
  return out;
}
