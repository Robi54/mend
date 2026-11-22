// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file's text split into lines, its line break and whether it ends with one (section 3). */
interface FileState { lines: string[]; br: string; ends: boolean; }

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const lines = text.split(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.ends ? s.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at or after `from`, with its positions (section 5). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

interface OLine { text: string; ctx: boolean; }

/** The lines N writes when O matched at pos (section 5): context lines as the file's own, tier 2 re-indentation. */
function writeN(lines: string[], pos: number, o: OLine[], n: OLine[], tier: number): string[] {
  const ctxFile: string[] = [];
  o.forEach((e, j) => { if (e.ctx) ctxFile.push(lines[pos + j]!); });
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  const f = o.length > 0 ? leadWs(lines[pos]!) : '';
  let ci = 0;
  const out: string[] = [];
  for (const e of n) {
    if (e.ctx) { out.push(ctxFile[ci]!); ci += 1; continue; }
    let t = e.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

interface Hunk { a: number; o: OLine[]; n: OLine[]; noNL: boolean; noNLPlus: boolean; }
interface Section { oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[]; }

const diffGitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `--- `/`+++ ` path: text after four characters, up to the first tab, trimmed; /dev/null is no file. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = st.lines;
  let ends = st.ends;
  let d = 0;
  for (const h of hunks) {
    const o = h.o.map((e) => e.text);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      const written = h.n.map((e) => e.text);
      lines = [...lines.slice(0, at), ...written, ...lines.slice(at)];
      if (atEnd) ends = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const written = writeN(lines, best, h.o, h.n, found.tier);
    const runsToEnd = best + o.length === lines.length;
    lines = [...lines.slice(0, best), ...written, ...lines.slice(best + o.length)];
    if (runsToEnd) ends = !h.noNL;
    d += h.n.length - h.o.length;
  }
  return { lines, br: st.br, ends };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = s.isCreate || oldP === null;
    const isDelete = !isCreate && (s.isDelete || newP === null);
    if (isCreate) {
      const p = newP;
      if (p === null) return;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusNoNL: boolean | null = null;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const e of h.n) if (!e.ctx) { plus.push(e.text); hasPlus = true; }
        if (hasPlus) lastPlusNoNL = h.noNLPlus;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNL === true ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(splitFile(before), s.hunks, strict, op);
      tree.now.set(np, joinFile(out));
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const out = applyHunks(splitFile(before), s.hunks, strict, p);
    tree.now.set(p, joinFile(out));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const err = (n: number): never => { throw new Exit2(`error: parse ${n}`); };
  const start = (s: Section): void => { sections.push(s); cur = s; inHeader = true; };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffGitRe.exec(line);
      if (m === null) err(i + 1);
      start({ oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) err(i + 1);
      const m = hunkRe.exec(line);
      if (m === null) err(i + 1);
      const a = Number(m[1]);
      inHeader = false;
      i += 1;
      const body: { kind: 'ctx' | 'old' | 'new'; text: string; raw: string; noNL: boolean }[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '', raw: '', noNL: false });
        else if (bl.startsWith(' ')) body.push({ kind: 'ctx', text: bl.slice(1), raw: bl, noNL: false });
        else if (bl.startsWith('-')) body.push({ kind: 'old', text: bl.slice(1), raw: bl, noNL: false });
        else if (bl.startsWith('+')) body.push({ kind: 'new', text: bl.slice(1), raw: bl, noNL: false });
        else if (bl.startsWith('\\')) { if (body.length > 0) body[body.length - 1]!.noNL = true; }
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      const o: OLine[] = [];
      const n: OLine[] = [];
      for (const b of body) {
        if (b.kind === 'ctx') { o.push({ text: b.text, ctx: true }); n.push({ text: b.text, ctx: true }); }
        else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else n.push({ text: b.text, ctx: false });
      }
      let noNL = false;
      let noNLPlus = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') { noNL = body[k]!.noNL; break; }
      }
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === 'new') { noNLPlus = body[k]!.noNL; break; }
      }
      cur.hunks.push({ a, o, n, noNL, noNLPlus });
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = diffPath(line);
        cur.newPath = diffPath(lines[i + 1]!);
      } else {
        start({ oldPath: diffPath(line), newPath: diffPath(lines[i + 1]!), isCreate: false, isDelete: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) err(i + 2);
      if (line.startsWith('+++ ')) cur.newPath = diffPath(line);
      else if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const o = oldLines.map((t) => ({ text: t, ctx: false }));
    const n = newLines.map((t) => ({ text: t, ctx: false }));
    const written = writeN(st.lines, pos, o, n, found.tier);
    st.lines = [...st.lines.slice(0, pos), ...written, ...st.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(st));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= blockEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    let sep = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    for (let j = sep + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { end = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    blockEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

interface VChunk { anchor: string | null; o: OLine[]; n: OLine[]; eof: boolean; }

function v4aUpdateEdit(path: string, raw: { text: string; n: number }[], sectionLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  let cur: VChunk | null = null;
  let started = false;
  const err = (n: number): never => { throw new Exit2(`error: parse ${n}`); };
  for (; idx < raw.length; idx++) {
    const { text, n } = raw[idx]!;
    if (text.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
      started = true;
      continue;
    }
    if (text.trimEnd() === '*** End of File') {
      if (cur === null) err(n);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (text.startsWith('*** ')) err(n);
    if (cur === null) {
      if (started) err(n);
      cur = { anchor: null, o: [], n: [], eof: false };
      started = true;
    }
    if (text === '') { cur.o.push({ text: '', ctx: true }); cur.n.push({ text: '', ctx: true }); }
    else if (text.startsWith(' ')) { cur.o.push({ text: text.slice(1), ctx: true }); cur.n.push({ text: text.slice(1), ctx: true }); }
    else if (text.startsWith('-')) cur.o.push({ text: text.slice(1), ctx: false });
    else if (text.startsWith('+')) cur.n.push({ text: text.slice(1), ctx: false });
    else err(n);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let lines = st.lines;
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        const found = findTier(lines, [c.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const o = c.o.map((e) => e.text);
      if (o.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const written = c.n.map((e) => e.text);
        lines = [...lines.slice(0, at), ...written, ...lines.slice(at)];
        cursor = at + written.length;
        continue;
      }
      const found = findTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos: number | null = null;
      for (const p of found.pos) {
        if (c.eof && p + o.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new Fail('no-match', path);
      const written = writeN(lines, pos, c.o, c.n, found.tier);
      lines = [...lines.slice(0, pos), ...written, ...lines.slice(pos + o.length)];
      cursor = pos + written.length;
    }
    const out = joinFile({ lines, br: st.br, ends: st.ends });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const err = (n: number): never => { throw new Exit2(`error: parse ${n}`); };
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (blank(l)) { raw.push(''); i += 1; continue; }
        if (l.startsWith('+')) { raw.push(l.slice(1)); i += 1; continue; }
        err(i + 1);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      edits.push(v4aAddEdit(path, raw));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const sectionLine = i + 1;
      i += 1;
      const raw: { text: string; n: number }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        raw.push({ text: l, n: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      edits.push(v4aUpdateEdit(path, raw, sectionLine, strict));
      continue;
    }
    err(i + 1);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [op, np] of tree.moves) {
    const wasOld = tree.original(op);
    const nowOld = tree.get(op);
    const wasNew = tree.original(np);
    const nowNew = tree.get(np);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      movedFrom.add(op);
      movedTo.add(np);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
