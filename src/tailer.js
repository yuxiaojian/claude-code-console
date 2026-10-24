import fs from 'node:fs/promises';

const CHUNK = 1 << 20; // 1 MiB
const EMPTY = Buffer.alloc(0);

/**
 * Incrementally reads appended lines from many files.
 *
 * - Only complete lines are emitted; a trailing partial line is held back
 *   until its newline arrives (Claude Code may be mid-write when we read).
 * - Reads of the same file are serialised, so overlapping change events
 *   can never read the same bytes twice.
 * - If a file shrinks (rewritten/truncated), it is re-read from the start.
 */
export class Tailer {
  constructor(onLine) {
    this.onLine = onLine;     // (line: string, filePath: string) => void
    this.files = new Map();   // filePath -> { offset, partial: Buffer, chain, pending }
  }

  /** Schedule a read of whatever has been appended since last time. */
  poke(filePath) {
    let st = this.files.get(filePath);
    if (!st) {
      st = { offset: 0, partial: EMPTY, chain: Promise.resolve(), pending: false };
      this.files.set(filePath, st);
    }
    // Coalesce bursts: if a read is already queued behind the current one, it will
    // pick up these bytes too.
    if (st.pending) return st.chain;
    st.pending = true;
    st.chain = st.chain.then(() => {
      st.pending = false;
      return this.#read(filePath, st);
    }).catch(() => {});
    return st.chain;
  }

  forget(filePath) {
    this.files.delete(filePath);
  }

  async #read(filePath, st) {
    let fh;
    try {
      fh = await fs.open(filePath, 'r');
    } catch {
      return; // deleted between event and read
    }
    try {
      const { size } = await fh.stat();
      if (size < st.offset) { st.offset = 0; st.partial = EMPTY; }
      const buf = Buffer.alloc(CHUNK);
      while (st.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - st.offset), st.offset);
        if (bytesRead === 0) break;
        st.offset += bytesRead;
        this.#consume(buf.subarray(0, bytesRead), filePath, st);
      }
    } finally {
      await fh.close();
    }
  }

  #consume(bytes, filePath, st) {
    // Work on raw bytes so a multi-byte UTF-8 char split across reads is never corrupted.
    let start = 0;
    for (let i; (i = bytes.indexOf(0x0a, start)) !== -1;) {
      let lineBytes = bytes.subarray(start, i);
      if (st.partial.length) {
        lineBytes = Buffer.concat([st.partial, lineBytes]);
        st.partial = EMPTY;
      }
      start = i + 1;
      const line = lineBytes.toString('utf8');
      if (line.trim()) this.onLine(line, filePath);
    }
    if (start < bytes.length) {
      // Copy: `bytes` is a view into a reused read buffer.
      st.partial = Buffer.concat([st.partial, bytes.subarray(start)]);
    }
  }
}
