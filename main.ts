// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls,
// finds the lines each edit names at the first of three matching tiers, and changes every
// file or none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (command line, output and exit codes, safe paths, format
// detection, JSON edits, order and atomicity) follow the kit starter's shape; sections 5 to 8
// (three-tier matching, unified diffs, SEARCH/REPLACE blocks, V4A patches) are implemented here.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  /** Successful move edits, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
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

/** Section 3: a file's lines, its line break, and whether it ends with one. */
interface FileText {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

/** Section 5: matching lines. A patch line: `ctx` marks a context line (in both O and N),
 * `oi` is its index in O, so the result takes the file's own matched line for it. */
interface PLine {
  text: string;
  ctx: boolean;
  oi: number;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Every 0-based position where O occurs in F at the tier, searching from `from`. */
function occurrencesAt(O: string[], F: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its occurrences. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: number; occs: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occs = occurrencesAt(O, F, t, from);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** The lines N writes for a matched span: context lines as the file's own matched lines,
 * other lines re-indented at tier 2 (section 5). */
function renderSpan(O: PLine[], N: PLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  for (const n of N) {
    if (n.ctx) {
      out.push(fileLines[at + n.oi]!);
      continue;
    }
    let s = n.text;
    if (tier === 2 && O.length > 0) {
      const f = leadingWs(fileLines[at]!);
      const p = leadingWs(O[0]!.text);
      if (s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    }
    out.push(s);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\' marker.
 * `empty` is true when the patch line itself was empty (a context line with empty text). */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

function bodyLinesToON(body: BodyLine[]): { O: PLine[]; N: PLine[] } {
  const O: PLine[] = [];
  const N: PLine[] = [];
  for (const bl of body) {
    if (bl.kind === ' ') {
      const p: PLine = { text: bl.text, ctx: true, oi: O.length };
      O.push(p);
      N.push(p);
    } else if (bl.kind === '-') {
      O.push({ text: bl.text, ctx: false, oi: -1 });
    } else if (bl.kind === '+') {
      N.push({ text: bl.text, ctx: false, oi: -1 });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the hunk/chunk's last context or `+` line (section 6). */
function backslashAfterLastN(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** Section 6: unified diffs. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  oldP: string | null;
  newP: string | null;
  create: boolean;
  del: boolean;
  hasPair: boolean;
  inHeader: boolean;
  hunks: Hunk[];
  line: number;
}

function patchPath(l: string): string | null {
  const raw = l.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldP: m[1]!, newP: m[2]!, create: false, del: false, hasPair: false, inHeader: true, hunks: [], line: i + 1 };
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) {
        if (cur !== null && cur.inHeader) {
          cur.oldP = patchPath(l);
          cur.newP = patchPath(nx);
          cur.hasPair = true;
        } else {
          cur = { oldP: patchPath(l), newP: patchPath(nx), create: false, del: false, hasPair: true, inHeader: true, hunks: [], line: i + 1 };
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          hunk.body.push(bl === '' ? { kind: ' ', text: '', empty: true } : { kind: bl[0] as BodyLine['kind'], text: bl.slice(1), empty: false });
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (l.startsWith('rename from ')) {
        if (!cur.hasPair) cur.oldP = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (!cur.hasPair) cur.newP = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.create = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.del = true;
      }
    }
    i++;
  }
  return sections;
}

/** Apply one unified section's hunks to a file's lines (section 6). */
function applyUnifiedHunks(sec: USection, f: FileText, strict: boolean, path: string): FileText {
  let lines = f.lines.slice();
  let finalBr = f.finalBr;
  let d = 0;
  for (const h of sec.hunks) {
    const { O, N } = bodyLinesToON(h.body);
    if (O.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = pos === lines.length;
      const ins = N.map((x) => x.text);
      lines.splice(pos, 0, ...ins);
      if (atEnd) finalBr = !backslashAfterLastN(h.body);
      d += N.length;
      continue;
    }
    const found = findTier(O.map((o) => o.text), lines, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let at = found.occs[0]!;
    let best = Math.abs(at - target);
    for (const o of found.occs) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        at = o;
        best = dist;
      }
    }
    const runsToEnd = at + O.length === lines.length;
    const rendered = renderSpan(O, N, lines, at, found.tier);
    lines.splice(at, O.length, ...rendered);
    if (runsToEnd) finalBr = !backslashAfterLastN(h.body);
    d += N.length - O.length;
  }
  return { br: f.br, lines, finalBr };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = unifiedSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      const oldP = sec.oldP;
      const newP = sec.newP;
      let kind: 'create' | 'delete' | 'move' | 'change';
      if (newP === null || sec.del) kind = 'delete';
      else if (oldP === null || sec.create) kind = 'create';
      else if (oldP !== newP) kind = 'move';
      else kind = 'change';
      if (kind === 'create') {
        const p = newP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: { text: string; noEol: boolean }[] = [];
        for (const h of sec.hunks) {
          const lastPlus = (() => {
            let idx = -1;
            for (let i = 0; i < h.body.length; i++) if (h.body[i]!.kind === '+') idx = i;
            return idx;
          })();
          for (let i = 0; i < h.body.length; i++) {
            if (h.body[i]!.kind === '+') {
              plus.push({ text: h.body[i]!.text, noEol: i === lastPlus && h.body[i + 1] !== undefined && h.body[i + 1]!.kind === '\\' });
            }
          }
        }
        const text = plus.length === 0 ? '' : plus.map((x) => x.text).join('\n') + (plus[plus.length - 1]!.noEol ? '' : '\n');
        tree.now.set(p, text);
        return;
      }
      if (kind === 'delete') {
        const p = oldP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (kind === 'move') {
        const np = newP!;
        if (!safe(np)) throw new Fail('unsafe', np);
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyUnifiedHunks(sec, splitFile(before), strict, p);
      const text = joinFile(out);
      if (kind === 'move') {
        tree.now.set(newP!, text);
        tree.now.set(p, null);
        tree.moves.push([p, newP!]);
      } else {
        tree.now.set(p, text);
      }
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const f = splitFile(before);
      const found = findTier(b.oldLines, f.lines, strict);
      if (!found) throw new Fail('no-match', b.path);
      if (found.occs.length > 1) throw new Fail('ambiguous', b.path);
      const at = found.occs[0]!;
      const O: PLine[] = b.oldLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
      const N: PLine[] = b.newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
      const rendered = renderSpan(O, N, f.lines, at, found.tier);
      const out = f.lines.slice();
      out.splice(at, O.length, ...rendered);
      tree.now.set(b.path, joinFile({ br: f.br, lines: out, finalBr: f.finalBr }));
    };
  });
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
}

function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const startOf = (l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const head = startOf(l);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i++;
    const raw: { text: string; line: number }[] = [];
    while (i < last && startOf(lines[i]!) === null) {
      raw.push({ text: lines[i]!, line: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (head.kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.line}`);
      }
      sections.push({ kind: 'add', path: head.path, line: secLine, moveTo: null, chunks: [], addLines });
      continue;
    }
    if (head.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
      sections.push({ kind: 'delete', path: head.path, line: secLine, moveTo: null, chunks: [], addLines: [] });
      continue;
    }
    let moveTo: string | null = null;
    let k = 0;
    while (k < raw.length && blank(raw[k]!.text)) k++;
    if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
      k++;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    for (; k < raw.length; k++) {
      const r = raw[k]!;
      const t = r.text;
      if (t.startsWith('@@')) {
        if (chunk !== null) chunks.push(chunk);
        chunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
        continue;
      }
      if (t.trim() === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${r.line}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        continue;
      }
      if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (chunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.line}`);
          chunk = { anchor: null, eof: false, body: [] };
        }
        chunk.body.push(t === '' ? { kind: ' ', text: '', empty: true } : { kind: t[0] as BodyLine['kind'], text: t.slice(1), empty: false });
        continue;
      }
      throw new Exit2(`error: parse ${r.line}`);
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    sections.push({ kind: 'update', path: head.path, line: secLine, moveTo, chunks, addLines: [] });
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = v4aSections(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const f = splitFile(before);
      let out = f.lines.slice();
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const ch of sec.chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          let foundIdx = -1;
          for (const t of tiers) {
            for (let i = cursor; i < out.length; i++) {
              if (normLine(out[i]!, t) === normLine(ch.anchor, t)) {
                foundIdx = i;
                break;
              }
            }
            if (foundIdx >= 0) break;
          }
          if (foundIdx < 0) throw new Fail('no-match', sec.path);
          cursor = foundIdx + 1;
        }
        const { O, N } = bodyLinesToON(ch.body);
        if (O.length === 0) {
          const pos = ch.eof ? out.length : cursor;
          out.splice(pos, 0, ...N.map((x) => x.text));
          cursor = pos + N.length;
          continue;
        }
        let found: { tier: number; at: number } | null = null;
        for (const t of tiers) {
          const occs = occurrencesAt(O.map((o) => o.text), out, t, cursor).filter((ix) => !ch.eof || ix + O.length === out.length);
          if (occs.length > 0) {
            found = { tier: t, at: occs[0]! };
            break;
          }
        }
        if (!found) throw new Fail('no-match', sec.path);
        const rendered = renderSpan(O, N, out, found.at, found.tier);
        out.splice(found.at, O.length, ...rendered);
        cursor = found.at + rendered.length;
      }
      const text = joinFile({ br: f.br, lines: out, finalBr: f.finalBr });
      if (sec.moveTo !== null) {
        tree.now.set(sec.moveTo, text);
        tree.now.set(sec.path, null);
        tree.moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, { key: string; line: string }>();
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.delete(oldP);
      rows.delete(newP);
      rows.set(`\u0000${newP}`, { key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = sorted.map((r) => r.line);
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
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
