// mend — a patch tool that reads AI-written edits in four formats (unified diffs, SEARCH/REPLACE blocks,
// V4A patches and JSON tool calls) and applies them to a tree of text files, every file changed or none.
// The contract is SPEC.md, in this repository; this file is a from-scratch implementation of it:
// sections 1-5 and 9-10 (command line, output, files and paths, detection, line matching, JSON edits,
// atomicity), section 7 (SEARCH/REPLACE) and section 8 (V4A). Section 6 (unified diffs) is in
// unified.ts's reader, folded into readUnified below. Node 22, standard library only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print (usage, no-patch, format or parse). */
class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path its error line names. */
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** The patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty tail piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A safe path (section 3): relative, no backslash, no empty, dot or dot-dot segments. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((x) => x !== '' && x !== '.' && x !== '..');
}

/**
 * A file as lines plus the two facts a rewrite must preserve (section 3): its own line break, and
 * whether it ends with one. An empty file has no lines and no final break; a file of no lines is
 * written empty whatever its flags say.
 */
interface Model {
  lines: string[];
  br: string;
  tail: boolean;
}

function modelOf(text: string): Model {
  if (text === '') return { lines: [], br: '\n', tail: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const tail = text.endsWith(br);
  const parts = text.split(br);
  if (tail) parts.pop();
  return { lines: parts, br, tail };
}

function textOf(m: Model): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.tail ? m.br : '');
}

/**
 * The tree as the edits leave it. `now` holds only the paths an edit has touched (null: deleted);
 * anything else reads through to the file on disk, cached in `disk`. `moves` records each move
 * edit's (old, new) pair so the report can print an R line for it (section 2).
 */
class Tree {
  private disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------- matching lines (section 5) ---------------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];

/** One line against another at a tier: 0 exact, 1 trailing blanks ignored, 2 both ends ignored. */
function sameLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchAt(lines: string[], at: number, old: string[], tier: number): boolean {
  if (at < 0 || at + old.length > lines.length) return false;
  for (let j = 0; j < old.length; j++) if (!sameLine(lines[at + j]!, old[j]!, tier)) return false;
  return true;
}

interface Found {
  tier: number;
  at: number[];
}

/** Every occurrence of `old` at or after `from`, at the first tier that has one (section 5). */
function findRun(lines: string[], old: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = from; i + old.length <= lines.length; i++) if (matchAt(lines, i, old, tier)) at.push(i);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * One body segment of a hunk, chunk or block: 'c' a line of both the old and the new text, 'd' an
 * old-only line, 'a' a new-only line. `nl` marks a "\" line after this segment (unified diffs).
 */
interface Seg {
  k: 'c' | 'd' | 'a';
  s: string;
  nl: boolean;
  /** True when this segment came from a completely empty patch line (unified bodies). */
  raw?: boolean;
}

/**
 * The lines a match writes, given the file's lines and the position the old text matched at.
 * Context segments come out as the file's own matched lines; at tier 2 every new-only segment is
 * re-indented, the file's first matched line's indent F taking the place of the old text's P.
 */
function render(fileLines: string[], at: number, segs: Seg[], tier: number): string[] {
  const firstOld = segs.find((g) => g.k !== 'a')!.s;
  const F = leadOf(fileLines[at]!);
  const P = leadOf(firstOld);
  const out: string[] = [];
  let oi = 0;
  for (const g of segs) {
    if (g.k === 'd') {
      oi++;
    } else if (g.k === 'c') {
      out.push(fileLines[at + oi]!);
      oi++;
    } else if (tier === 2 && g.s !== '' && stripBoth(g.s) !== '' && g.s.startsWith(P)) {
      out.push(F + g.s.slice(P.length));
    } else {
      out.push(g.s);
    }
  }
  return out;
}

/* ---------------- JSON edits (section 9) ---------------- */

/** One JSON edit object as an Edit, or null when it is not a valid one (a parse fault). */
function jsonObjectEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldS = o.old_str;
    const newS = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const crlf = modelOf(before).br === '\r\n';
      const flat = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const hay = flat(before);
      const needle = flat(oldS);
      let hits = 0;
      let at = -1;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) {
        hits++;
        at = k;
      }
      if (hits === 0) throw new Fail('no-match', path);
      if (hits > 1) throw new Fail('ambiguous', path);
      const joined = hay.slice(0, at) + flat(newS) + hay.slice(at + needle.length);
      tree.now.set(path, crlf ? joined.split('\n').join('\r\n') : joined);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const m = modelOf(needFile(tree));
      if (at < 0 || at > m.lines.length) throw new Fail('no-match', path);
      m.lines.splice(at, 0, ...add);
      tree.now.set(path, textOf(m));
    };
  }
  return null;
}

/** The JSON reader: one array of edit objects, or JSON Lines with one object a line. */
function readJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${first + 1}`);
    return parsed.map((x) => {
      const e = jsonObjectEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      return e;
    });
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonObjectEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- SEARCH/REPLACE blocks (section 7) ---------------- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const m = modelOf(before);
    const found = findRun(m.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const at = found.at[0]!;
    const segs: Seg[] = [
      ...oldLines.map((s): Seg => ({ k: 'd', s, nl: false })),
      ...newLines.map((s): Seg => ({ k: 'a', s, nl: false })),
    ];
    m.lines.splice(at, oldLines.length, ...render(m.lines, at, segs, found.tier));
    tree.now.set(path, textOf(m));
  };
}

function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | undefined;
  let floor = 0; // a block's path line is searched at or after this index
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    let path = prevPath;
    for (let j = searchAt - 1; j >= floor; j--) {
      const l = lines[j]!;
      if (isBlank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) throw new Exit2(`error: parse ${searchAt + 1}`);
    edits.push(srEdit(path, lines.slice(searchAt + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    floor = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---------------- V4A patches (section 8) ---------------- */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  segs: Seg[];
}

function v4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) if (sameLine(lines[i]!, anchor, t)) return i;
  }
  return -1;
}

function v4aUpdate(path: string, moveTo: string | undefined, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = modelOf(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(m.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const old = ch.segs.filter((g) => g.k !== 'a').map((g) => g.s);
      if (old.length === 0) {
        const adds = ch.segs.map((g) => g.s);
        const at = ch.eof ? m.lines.length : Math.min(cursor, m.lines.length);
        m.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
        continue;
      }
      if (ch.eof) {
        const at = m.lines.length - old.length;
        let tier = -1;
        if (at >= cursor) {
          for (const t of strict ? [0] : [0, 1, 2]) {
            if (matchAt(m.lines, at, old, t)) {
              tier = t;
              break;
            }
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const written = render(m.lines, at, ch.segs, tier);
        m.lines.splice(at, old.length, ...written);
        cursor = at + written.length;
        continue;
      }
      const found = findRun(m.lines, old, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      const at = found.at[0]!;
      const written = render(m.lines, at, ch.segs, found.tier);
      m.lines.splice(at, old.length, ...written);
      cursor = at + written.length;
    }
    const text = textOf(m);
    if (moveTo !== undefined) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

const V4A_HEADS: Array<{ pre: string; kind: 'add' | 'del' | 'upd' }> = [
  { pre: '*** Add File: ', kind: 'add' },
  { pre: '*** Delete File: ', kind: 'del' },
  { pre: '*** Update File: ', kind: 'upd' },
];

function readV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const headOf = (l: string): { pre: string; kind: 'add' | 'del' | 'upd' } | null => V4A_HEADS.find((h) => l.startsWith(h.pre)) ?? null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const head = headOf(lines[i]!);
    if (head === null) {
      if (isBlank(lines[i]!)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headAt = i;
    const path = lines[i]!.slice(head.pre.length).trim();
    // The section's lines run to the next section head or to the End Patch line; blank lines at
    // the section's end are not part of it.
    let j = i + 1;
    const body: Array<{ l: string; no: number }> = [];
    while (j < last && headOf(lines[j]!) === null) {
      body.push({ l: lines[j]!, no: j + 1 });
      j++;
    }
    while (body.length > 0 && isBlank(body[body.length - 1]!.l)) body.pop();
    if (head.kind === 'add') {
      const fileLines: string[] = [];
      for (const { l, no } of body) {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
      edits.push(v4aAdd(path, fileLines));
    } else if (head.kind === 'del') {
      for (const { l, no } of body) if (!isBlank(l)) throw new Exit2(`error: parse ${no}`);
      edits.push(v4aDelete(path));
    } else {
      edits.push(v4aUpdateEdit(path, body, headAt, strict));
    }
    i = j;
  }
  return edits;
}

/** One Update File section's chunks (and its Move to) as an Edit. */
function v4aUpdateEdit(path: string, body: Array<{ l: string; no: number }>, headAt: number, strict: boolean): Edit {
  let moveTo: string | undefined;
  const chunks: Array<Chunk & { closed: boolean }> = [];
  let cur: (Chunk & { closed: boolean }) | null = null;
  let started = false;
  for (const { l, no } of body) {
    if (!started && isBlank(l)) continue;
    if (!started && l.startsWith('*** Move to: ')) {
      moveTo = l.slice('*** Move to: '.length).trim();
      started = true;
      continue;
    }
    started = true;
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${no}`);
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, segs: [], closed: false };
      chunks.push(cur);
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null || cur.closed) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur.closed = true;
      continue;
    }
    if (l === '') {
      if (cur !== null && !cur.closed) cur.segs.push({ k: 'c', s: '', nl: false });
      continue;
    }
    const c0 = l[0]!;
    if (c0 === ' ' || c0 === '-' || c0 === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, segs: [], closed: false };
        chunks.push(cur);
      }
      if (cur.closed) throw new Exit2(`error: parse ${no}`);
      cur.segs.push({ k: c0 === ' ' ? 'c' : c0 === '-' ? 'd' : 'a', s: l.slice(1), nl: false });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headAt + 1}`);
  return v4aUpdate(path, moveTo, chunks, strict);
}

/* ---------------- unified diffs (section 6) ---------------- */

interface UHunk {
  a: number;
  segs: Seg[];
}

interface USection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair seen; null: /dev/null
  pairNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  newMode: boolean;
  delMode: boolean;
  inHeader: boolean;
  hunks: UHunk[];
}

/** The path a --- or +++ line names: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.replace(/^ +| +$/g, '');
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line; any other shape is a parse fault at its line. */
function gitPaths(line: string, no: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${no}`);
  const cut = rest.indexOf(' b/', 2);
  if (cut < 0) throw new Exit2(`error: parse ${no}`);
  return { x: rest.slice(2, cut), y: rest.slice(cut + 3) };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A hunk's body: the lines after its header that start with a space, -, + or \, or are empty (an
 * empty line is a context line whose text is empty). It ends at the first other line, at a
 * `diff --git ` line or at a --- line followed by a +++ line; empty patch lines at its end are
 * not part of it. A \ line marks the body line before it.
 */
function collectBody(lines: string[], from: number): { segs: Seg[]; next: number } {
  const raw: Seg[] = [];
  let j = from;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      raw.push({ k: 'c', s: '', nl: false, raw: true });
      j++;
      continue;
    }
    const c0 = l[0]!;
    if (c0 === ' ') raw.push({ k: 'c', s: l.slice(1), nl: false });
    else if (c0 === '-') raw.push({ k: 'd', s: l.slice(1), nl: false });
    else if (c0 === '+') raw.push({ k: 'a', s: l.slice(1), nl: false });
    else if (c0 === '\\') {
      if (raw.length > 0) raw[raw.length - 1]!.nl = true;
    } else break;
    j++;
  }
  let end = raw.length;
  while (end > 0 && raw[end - 1]!.raw === true) end--;
  return { segs: raw.slice(0, end), next: j };
}

/**
 * Apply one section's hunks in order to a file model. d is the running drift: the sum over the
 * hunks applied so far of (new length - old length). A hunk whose matched lines run to the end of
 * the file decides the result's final break: it keeps one unless a \ line follows the hunk's last
 * context or + line.
 */
function applyHunks(m: Model, hunks: UHunk[], strict: boolean, errPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const old = h.segs.filter((g) => g.k !== 'a').map((g) => g.s);
    const nLen = h.segs.filter((g) => g.k !== 'd').length;
    const lastCA = [...h.segs].reverse().find((g) => g.k !== 'd');
    if (old.length > 0) {
      const found = findRun(m.lines, old, strict, 0);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let at = found.at[0]!;
      for (const p of found.at) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      const reached = at + old.length === m.lines.length;
      const written = render(m.lines, at, h.segs, found.tier);
      m.lines.splice(at, old.length, ...written);
      if (reached) m.tail = lastCA === undefined || !lastCA.nl;
    } else {
      const adds = h.segs.filter((g) => g.k === 'a').map((g) => g.s);
      const at = Math.max(0, Math.min(h.a + d, m.lines.length));
      const reached = at === m.lines.length;
      m.lines.splice(at, 0, ...adds);
      if (reached) m.tail = lastCA === undefined || !lastCA.nl;
    }
    d += nLen - old.length;
  }
}

/** One unified section as an Edit: a creation, a deletion, a move or a change (section 6). */
function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renFrom !== undefined ? sec.renFrom : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renTo !== undefined ? sec.renTo : sec.gitNew;
  const hunks = sec.hunks;
  return (tree) => {
    // Every path the edit names is checked for safety before anything else (section 10).
    if (oldPath !== undefined && oldPath !== null && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== undefined && newPath !== null && !safePath(newPath)) throw new Fail('unsafe', newPath);
    if (newPath !== null && newPath !== undefined && (oldPath === null || sec.newMode)) {
      // a creation: the file is the + lines of all its hunks, in order
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const adds = hunks.flatMap((h) => h.segs.filter((g) => g.k === 'a'));
      const lastAdd = adds[adds.length - 1];
      const tail = lastAdd === undefined || !lastAdd.nl;
      tree.now.set(newPath, adds.length === 0 ? '' : adds.map((g) => g.s).join('\n') + (tail ? '\n' : ''));
      return;
    }
    if (newPath === null || sec.delMode) {
      // a deletion: its hunks are not read
      if (oldPath === null || oldPath === undefined || tree.get(oldPath) === null) throw new Fail('missing', oldPath ?? '');
      tree.now.set(oldPath, null);
      return;
    }
    const src = oldPath!;
    const isMove = src !== newPath;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const m = modelOf(before);
    applyHunks(m, hunks, strict, src);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(newPath, textOf(m));
      tree.moves.push([src, newPath]);
    } else {
      tree.now.set(src, textOf(m));
    }
  };
}

function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  const fresh = (): USection => ({
    gitOld: undefined,
    gitNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renFrom: undefined,
    renTo: undefined,
    newMode: false,
    delMode: false,
    inHeader: true,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const { x, y } = gitPaths(l, i + 1);
      sec = fresh();
      sec.gitOld = x;
      sec.gitNew = y;
      sections.push(sec);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const po = headerPath(l);
      const pn = headerPath(lines[i + 1]!);
      if (sec !== null && sec.inHeader && sec.pairOld === undefined) {
        sec.pairOld = po;
        sec.pairNew = pn;
      } else {
        sec = fresh();
        sec.pairOld = po;
        sec.pairNew = pn;
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && sec !== null && sec.inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const mm = HUNK_RE.exec(l);
      if (mm === null) throw new Exit2(`error: parse ${i + 1}`);
      sec.inHeader = false;
      const { segs, next } = collectBody(lines, i + 1);
      sec.hunks.push({ a: Number(mm[1]), segs });
      i = next;
      continue;
    }
    if (sec !== null && sec.inHeader) {
      if (l.startsWith('rename from ')) sec.renFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newMode = true;
      else if (l.startsWith('deleted file mode')) sec.delMode = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ---------------- detecting the format (section 4) ---------------- */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------- the command line, the run and the report (sections 1, 2 and 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
        continue;
      }
      if (a === '--check' && !checkOnly) {
        checkOnly = true;
        continue;
      }
      if (a === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, out: ['error: usage'] };
    }
    pos.push(a);
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
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? readJson(text, lines)
        : kind === 'search-replace'
          ? readSearchReplace(lines, strict)
          : kind === 'v4a'
            ? readV4a(lines, strict)
            : readUnified(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  // A move the patch leaves standing (old gone, new present, both as the move made them) is
  // reported as one R line in place of the pair's D and A lines, sorted by the new path.
  const movedInto = new Map<string, string>();
  const movedAway = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      movedInto.set(n, o);
      movedAway.add(o);
    }
  }
  const keyed: Array<{ key: string; line: string }> = [];
  for (const p of changed) {
    if (movedAway.has(p)) continue;
    if (movedInto.has(p)) {
      keyed.push({ key: p, line: `R ${movedInto.get(p)} -> ${p}` });
      continue;
    }
    const was = tree.original(p);
    const cur = tree.now.get(p)!;
    keyed.push({ key: p, line: `${was === null ? 'A' : cur === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!checkOnly) {
    for (const p of changed) {
      const cur = tree.now.get(p)!;
      if (cur === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, cur);
      }
    }
  }
  const rows = keyed.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
