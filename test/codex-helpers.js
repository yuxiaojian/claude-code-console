// Synthetic Codex rollout lines, shaped like the ones Codex CLI 0.164.0 writes
// (see test/fixtures/codex/rollout-0.164.0-exec.jsonl for a captured, trimmed original).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ids = {
  a: '01a10000-0000-7000-8000-00000000000a',
  b: '01a10000-0000-7000-8000-00000000000b',
  c: '01a10000-0000-7000-8000-00000000000c',
  d: '01a10000-0000-7000-8000-00000000000d',
  sub: '01a10000-0000-7000-8000-0000000000aa',
};

const at = s => new Date(Date.now() - 60_000 + s * 1000).toISOString();

export const meta = (id, extra = {}, sec = 0) => ({
  timestamp: at(sec), type: 'session_meta',
  payload: { session_id: id, id, timestamp: at(sec), cwd: '/tmp/proj', originator: 'codex-tui', cli_version: '0.164.0', source: 'cli', thread_source: 'user', git: { branch: 'main' }, ...extra },
});
export const turnContext = (sec = 1, extra = {}) => ({ timestamp: at(sec), type: 'turn_context', payload: { cwd: '/tmp/proj', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' }, model: 'gpt-test', ...extra } });
export const started = (sec = 1) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 400_000 } });
export const user = (text, sec = 2, id = `u-${text}`) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id, content: [{ type: 'text', text }] } } });
export const agent = (text, sec = 3, id = `m-${text}`) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] } } });
export const call = (callId, sec = 4) => ({ timestamp: at(sec), type: 'response_item', payload: { type: 'custom_tool_call', call_id: callId, name: 'exec', input: 'ls -la' } });
export const output = (callId, sec = 5) => ({ timestamp: at(sec), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [] } });
export const command = (cmd, out, sec = 5, extra = {}) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: `c-${cmd}`, command: ['/bin/zsh', '-lc', cmd], status: 'completed', aggregated_output: out, exit_code: 0, ...extra } } });
export const fileChange = (file, change, sec = 6) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: `f-${file}`, status: 'completed', changes: { [file]: change } } } });
export const complete = (sec = 7) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' } });
export const aborted = (sec = 7) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } });
export const usage = (owner, responseId, tokens = {}, sec = 4, extra = {}) => ({
  timestamp: at(sec), type: 'token_usage_record',
  payload: { thread_id: owner, session_id: owner, response_id: responseId, usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, ...tokens }, ...extra },
});
export const count = (total, sec = 4) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: total }, model_context_window: 400_000 } } });

export const lines = events => events.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';

/** Write rollout files into a temp dir; returns name -> path. */
export function writeRollouts(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-codex-'));
  const out = {};
  for (const [name, events] of Object.entries(files)) {
    out[name] = path.join(dir, `rollout-${name}.jsonl`);
    fs.writeFileSync(out[name], lines(events));
  }
  return out;
}

/** Feed files to a store in the given order. */
export function ingestFiles(store, paths) {
  for (const p of paths) for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l.trim()) store.ingestLine(l, p);
}
