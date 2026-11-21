// Reading a package's public surface from its files: entry points from package.json, exported
// names from type declarations or the entry file, the declaration and doc comment of one symbol,
// README sections and CHANGELOG entries. All by line patterns; nothing is executed or parsed in full.
import { clip, compareVersions, parseVersion } from "./util.mjs";

// ---- package.json entry points ----

const pickTarget = (v, prefer) => {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return pickTarget(v[0], prefer);
  if (!v || typeof v !== "object") return null;
  for (const k of prefer) if (k in v) return pickTarget(v[k], prefer) ?? null;
  for (const x of Object.values(v)) {
    const t = pickTarget(x, prefer);
    if (t) return t;
  }
  return null;
};

/** {main, module, types, bin, type, exports:[{subpath, types, import, require|default}], moreExports} from a package.json. */
export function entryPoints(pj, { maxExports = 25 } = {}) {
  const out = { type: pj.type ?? "commonjs", main: pj.main ?? null, module: pj.module ?? null, types: pj.types ?? pj.typings ?? null, bin: null, exports: null };
  const tidy = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  if (pj.bin) out.bin = typeof pj.bin === "string" ? { [String(pj.name).split("/").pop()]: pj.bin } : pj.bin;
  const ex = pj.exports;
  if (ex !== undefined) {
    const subpaths = typeof ex === "string" || Array.isArray(ex) || !Object.keys(ex).some((k) => k.startsWith(".")) ? { ".": ex } : ex;
    const rows = Object.entries(subpaths).map(([subpath, v]) => {
      const row = { subpath };
      const types = pickTarget(typeof v === "object" ? v : null, ["types"]);
      if (types && /\.d\.[cm]?ts$/.test(types)) row.types = types;
      const imp = pickTarget(v, ["import", "default", "require", "node"]);
      const req = typeof v === "object" && v ? pickTarget(v.require ?? null, ["default"]) : null;
      if (imp && !/\.d\.[cm]?ts$/.test(imp)) row.import = imp;
      if (req && req !== imp && !/\.d\.[cm]?ts$/.test(req)) row.require = req;
      if (v === null) row.blocked = true;
      return row;
    });
    out.exports = rows.slice(0, maxExports);
    if (rows.length > maxExports) out.moreExports = rows.length - maxExports;
    out.types ??= rows.find((r) => r.subpath === ".")?.types ?? null;
  }
  return tidy(out);
}

/** The files that may hold the declarations of the package's main entry, most likely first. */
export function typeCandidates(pj) {
  const e = entryPoints(pj);
  const main = e.exports?.find((r) => r.subpath === ".")?.import ?? e.module ?? e.main ?? "index.js";
  const swap = (f) => f.replace(/\.mjs$/, ".d.mts").replace(/\.cjs$/, ".d.cts").replace(/\.jsx?$/, ".d.ts");
  const norm = (f) => String(f).replace(/^\.\//, "");
  return [...new Set([e.types, swap(main), main.replace(/\.[cm]?js$/, "") + ".d.ts", "index.d.ts", "dist/index.d.ts", "lib/index.d.ts", "types/index.d.ts"].filter(Boolean).map(norm))];
}

// ---- exported names ----

const DECL = /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const PLAIN_DECL = /^(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;

/**
 * Exported names of a module, following `export * from` and `export {..} from` into sibling files.
 * `read(rel)` resolves to the text of a file in the package or null. Returns {names:[{name, kind, at}], files:[rel], truncated}.
 */
export async function exportedNames(read, entry, { maxFiles = 30, maxNames = 400 } = {}) {
  const names = new Map();
  const files = [];
  let truncated = false;
  const add = (name, kind, at) => {
    if (names.size >= maxNames) truncated = true;
    else if (!names.has(name) || names.get(name).kind === "re-export") names.set(name, { name, kind, at });
  };
  const cache = new Map();
  const get = async (rel) => (cache.has(rel) ? cache.get(rel) : cache.set(rel, await read(rel)).get(rel));
  const resolve = async (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = from.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === "..") base.pop();
      else if (part !== "." && part) base.push(part);
    }
    const p = base.join("/");
    const dts = /\.d\.[cm]?ts$/.test(from);
    const cands = dts
      ? [p.replace(/\.mjs$/, ".d.mts").replace(/\.cjs$/, ".d.cts").replace(/\.js$/, ".d.ts"), p + ".d.ts", p + ".d.mts", p + ".d.cts", p + "/index.d.ts", p]
      : [p, p + ".js", p + ".mjs", p + ".cjs", p + "/index.js"];
    for (const c of cands) if ((await get(c)) !== null) return c;
    return null;
  };
  const visit = async (rel, depth) => {
    if (files.includes(rel)) return;
    if (files.length >= maxFiles || depth > 6) {
      truncated = true;
      return;
    }
    const text = await get(rel);
    if (text === null) return;
    files.push(rel);
    const lines = text.split("\n");
    // In a bundled declaration file names are declared plainly and exported in one `export { a, b as c }` at the end.
    const local = new Map();
    lines.forEach((line, i) => {
      const m = PLAIN_DECL.exec(line);
      if (m && !local.has(m[2])) local.set(m[2], { kind: m[1].replace("*", ""), line: i + 1 });
    });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^\s*(export\b|module\.exports|exports\.)/.test(line)) continue;
      const d = DECL.exec(line);
      if (d) {
        add(d[2], d[1].replace("*", ""), `${rel}:${i + 1}`);
        continue;
      }
      if (/^\s*export\s+default\b/.test(line)) add("default", "default", `${rel}:${i + 1}`);
      let m = /^\s*export\s+(?:type\s+)?\*\s*(?:as\s+([\w$]+)\s+)?from\s+["']([^"']+)["']/.exec(line);
      if (m) {
        const target = await resolve(rel, m[2]);
        if (m[1]) add(m[1], "namespace", `${rel}:${i + 1}`);
        else if (target) await visit(target, depth + 1);
        else add(`* from ${m[2]}`, "re-export", `${rel}:${i + 1}`);
        continue;
      }
      if (/^\s*export\s+(?:type\s+)?\{/.test(line)) {
        // The braces may span lines.
        let block = line;
        let j = i;
        while (!block.includes("}") && j + 1 < lines.length && j - i < 400) block += " " + lines[++j];
        const from = /\}\s*from\s+["']([^"']+)["']/.exec(block)?.[1];
        const target = from ? await resolve(rel, from) : null;
        for (const part of block.slice(block.indexOf("{") + 1, block.indexOf("}")).split(",")) {
          const pm = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
          if (!pm) continue;
          const name = pm[2] ?? pm[1];
          const loc = !from ? local.get(pm[1]) : null;
          add(name, loc?.kind ?? "re-export", loc ? `${rel}:${loc.line}` : target ? `${target}` : `${rel}:${i + 1}`);
        }
        continue;
      }
      m = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (m && m[1] !== "__esModule") add(m[1], "export", `${rel}:${i + 1}`);
      if (/^\s*module\.exports\s*=\s*\{/.test(line)) {
        let block = line;
        let j = i;
        while (!block.includes("}") && j + 1 < lines.length && j - i < 80) block += " " + lines[++j];
        for (const km of block.slice(block.indexOf("{") + 1).matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[,:}(])/g)) add(km[1], "export", `${rel}:${i + 1}`);
      } else {
        m = /^\s*module\.exports\s*=\s*(?:function\s*|class\s*)?([A-Za-z_$][\w$]*)?/.exec(line);
        if (m) add("module.exports", m[1] ? `= ${m[1]}` : "export", `${rel}:${i + 1}`);
      }
    }
  };
  await visit(entry, 0);
  return { names: [...names.values()], files, truncated };
}

// ---- one symbol ----

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Per language: which files, the line pattern of a declaration of NAME, and how doc comments look.
export const LANGS = {
  ts: {
    files: /\.d\.[cm]?ts$/,
    fallbackFiles: /\.(?:[cm]?js|ts)$/,
    skip: /\.min\.[cm]?js$|\.map$/,
    decl: (n) => new RegExp(`(?:^|[\\s;{(,])(?:function\\*?|class|interface|type|const|let|var|enum|namespace)\\s+${n}(?![\\w$])|^\\s*(?:(?:export|declare|public|static|readonly|abstract|protected|async|get|set|default)\\s+)*${n}\\s*[<(?:=]|^\\s*(?:module\\.)?exports\\.${n}\\s*=`),
    doc: "block",
  },
  python: { files: /\.pyi?$/, decl: (n) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(|^\\s*class\\s+${n}\\b|^${n}\\s*(?::[^=]+)?=`), doc: "docstring" },
  rust: { files: /\.rs$/, decl: (n) => new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:(?:async|const|unsafe|default|extern\\s+"C")\\s+)*(?:fn|struct|enum|trait|type|const|static|mod|union)\\s+${n}\\b|^\\s*macro_rules!\\s+${n}\\b`), doc: "///" },
  go: { files: /\.go$/, skip: /_test\.go$/, decl: (n) => new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[(\\[]|^type\\s+${n}\\b|^\\s*(?:const|var)\\s+${n}\\b|^\\t${n}\\s+.*=|^\\t${n}\\s*=`), doc: "//" },
};

/** Declarations of `symbol` in one file's text: [{line, signature, doc}]. `name` is a regex fragment for the name. */
export function findDeclarations(text, lang, name, { max = 5 } = {}) {
  const L = LANGS[lang];
  const re = L.decl(name);
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (lines[i].length > 2000 || !re.test(lines[i])) continue;
    if (/^\s*(\/\/|\*|\/\*|#)/.test(lines[i])) continue; // a mention in a comment
    // The signature: this line and the following ones until brackets balance and the statement ends.
    let sig = lines[i].trim();
    let depth = 0;
    const count = (s) => {
      for (const c of s) depth += c === "(" || c === "<" || c === "[" ? 1 : c === ")" || c === ">" || c === "]" ? -1 : 0;
    };
    count(lines[i].replace(/=>/g, ""));
    let j = i;
    const done = (s) => (lang === "python" ? /:\s*(#.*)?$/.test(s) && depth <= 0 : depth <= 0 && /[;{}]\s*$|^\s*$/.test(s));
    while (!done(lines[j]) && j + 1 < lines.length && j - i < 14 && sig.length < 900) {
      j++;
      count(lines[j].replace(/=>/g, ""));
      sig += "\n" + lines[j].trimEnd();
    }
    // The doc comment.
    let doc = "";
    if (L.doc === "block") {
      let k = i - 1;
      while (k >= 0 && /^\s*(@\w+.*)?$/.test(lines[k]) && i - k < 3) k--;
      if (k >= 0 && /\*\/\s*$/.test(lines[k])) {
        const end = k;
        while (k > 0 && !/\/\*\*?/.test(lines[k]) && end - k < 40) k--;
        doc = lines.slice(k, end + 1).map((l) => l.replace(/^\s*\/?\*+\/?\s?/, "").replace(/\*\/\s*$/, "").trimEnd()).filter((l, n, a) => l || (n > 0 && n < a.length - 1)).join("\n").trim();
      }
    } else if (L.doc === "docstring") {
      const q = /^\s*[rRbBuU]*("""|''')(.*)$/.exec(lines[j + 1] ?? "");
      if (q) {
        const body = [q[2]];
        let k = j + 1;
        while (!body.at(-1).includes(q[1]) && k + 1 < lines.length && k - j < 14) body.push(lines[++k].trim());
        doc = body.join("\n").split(q[1])[0].trim();
      }
    } else {
      const body = [];
      for (let k = i - 1; k >= 0 && i - k < 30; k--) {
        const t = lines[k].trim();
        if (t.startsWith(L.doc)) body.unshift(t.slice(L.doc.length).replace(/^\s/, ""));
        else if (lang === "rust" && /^#\[/.test(t)) continue;
        else break;
      }
      doc = body.join("\n").trim();
    }
    out.push({ line: i + 1, signature: clip(sig, 700), ...(doc ? { doc: clip(doc, 500) } : {}) });
  }
  return out;
}

export const symbolPattern = (symbol, mode) => (mode === "exact" ? esc(symbol) : mode === "anycase" ? esc(symbol).replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`) : `[\\w$]*${esc(symbol).replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)}[\\w$]*`);

// ---- README ----

/** Markdown sections: [{heading, level, line, text}]; the text before the first heading has heading "". Fenced code is not split. */
export function markdownSections(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [{ heading: "", level: 0, line: 1, body: [] }];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    const setext = !fence && i > 0 && /^(=+|-{3,})\s*$/.test(l) && lines[i - 1].trim() && !/^\s*[-*#>|]/.test(lines[i - 1]) && out.at(-1).body.length;
    if (h) out.push({ heading: h[2].replace(/<[^>]+>/g, "").trim(), level: h[1].length, line: i + 1, body: [] });
    else if (setext) {
      const title = out.at(-1).body.pop();
      out.push({ heading: title.trim(), level: l.startsWith("=") ? 1 : 2, line: i, body: [] });
    } else out.at(-1).body.push(l);
  });
  return out.map((s) => ({ heading: s.heading, level: s.level, line: s.line, text: s.body.join("\n").trim() }));
}

/** README answer: with a topic, the sections whose heading (then body) matches; without, the introduction and the list of headings. */
export function readme(text, file, { topic, max = 3, chars = 1500 } = {}) {
  const secs = markdownSections(text);
  const strip = (t) => t.split("\n").filter((l) => !/^\s*(\[!\[|<|!\[)|<\/?(span|a|img|br|sub|sup)\b/i.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const headings = secs.filter((s) => s.heading).map((s) => `${"  ".repeat(Math.max(0, s.level - 1))}${s.heading} (${file}:${s.line})`);
  if (!topic) {
    const intro = secs.map((s) => strip(s.text)).find((t) => t.length > 0) ?? "";
    return { file, intro: clip(intro, 700), headings: headings.slice(0, 40), ...(headings.length > 40 ? { moreHeadings: headings.length - 40 } : {}) };
  }
  const words = String(topic).split(/\s+/).filter(Boolean).map(esc);
  const re = new RegExp(words.join("|"), "i");
  const all = new RegExp(words.map((w) => `(?=[\\s\\S]*${w})`).join(""), "i");
  const scored = secs.map((s) => ({ s, score: (s.heading && all.test(s.heading) ? 8 : s.heading && re.test(s.heading) ? 5 : 0) + (all.test(s.text) ? 2 : re.test(s.text) ? 1 : 0) })).filter((x) => x.score > 0 && (x.s.text || x.s.heading));
  scored.sort((a, b) => b.score - a.score || a.s.line - b.s.line);
  return {
    file,
    topic,
    sections: scored.slice(0, max).map(({ s, score }) => ({ heading: s.heading || "(introduction)", at: `${file}:${s.line}`, matched: score >= 5 ? "heading" : "text", text: clip(strip(s.text), chars) })),
    ...(scored.length > max ? { moreMatches: scored.length - max } : {}),
    ...(scored.length ? {} : { headings: headings.slice(0, 40) }),
  };
}

// ---- CHANGELOG ----

export const CHANGELOG_FILE = /^(changelog|changes|history|news|releases?|release[-_ ]?notes)(\.(md|markdown|mdown|txt|rst))?$/i;
export const README_FILE = /^readme(\.(md|markdown|mdown|txt|rst))?$/i;

/** Version entries of a changelog, in file order: [{version, date, line, text}]. A heading counts when it holds a version number. */
export function changelogEntries(text) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => {
    const under = /^(=+|-{3,}|~{3,})\s*$/.test(lines[i + 1] ?? "");
    const m = /^(#{1,4})\s*(?:\[?(?:[A-Za-z@/_-]+[\s@])?v?(\d+\.\d+(?:\.\d+)?(?:[-.+][0-9A-Za-z.-]+)?)\]?)/.exec(l) ?? (under || /^v?\d+\.\d+\.\d+\S*\s+[/(-]/.test(l) ? /^()\[?v?(\d+\.\d+(?:\.\d+)?(?:[-.+][0-9A-Za-z.-]+)?)\]?(?:\s|$)/.exec(l) : null);
    if (m && parseVersion(m[2])) heads.push({ version: m[2], line: i + 1, level: m[1].length, date: /(\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2})/.exec(l)?.[1] ?? null, under });
  });
  // Sub-headings that also start with a version number are part of their parent's entry.
  const top = Math.min(...heads.map((h) => h.level));
  const main = heads.filter((h) => h.level === top);
  return main.map((h, k) => ({ version: h.version, date: h.date, line: h.line, text: lines.slice(h.line + (h.under ? 1 : 0), (main[k + 1]?.line ?? lines.length + 1) - 1).join("\n").trim() }));
}

/** The entries above `from` up to and including `to`; with no `from`, the `last` entries up to `to`. Newest first. */
export function changesBetween(entries, { from, to, last = 3 } = {}) {
  const sorted = [...entries].sort((a, b) => compareVersions(b.version, a.version));
  const upTo = to ? sorted.filter((e) => compareVersions(e.version, to) <= 0) : sorted;
  const picked = from ? upTo.filter((e) => compareVersions(e.version, from) > 0) : upTo.slice(0, last);
  return { picked, newer: to ? sorted.length - upTo.length : 0 };
}
