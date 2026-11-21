import { LANGS, README_FILE, entryPoints, exportedNames, findDeclarations, readme, symbolPattern, typeCandidates } from "../lib/api.mjs";

export const meta = {
  purpose:
    "How do I call an installed package, in the version that is installed? Its entry points (package.json exports, main, types, bin), the names it exports (from its type declarations, or its entry file when it ships none), and with `symbol` the declarations and doc comments of that name with path:line inside the package; with `topic` the README section about it. For Python: the top-level modules and the def and class lines. Use it instead of looking documentation up on the web.",
  params: { name: "the package", symbol: "a function, class, type or method name to look up, optional", topic: "words to find a README section by, optional", eco: "npm | python | cargo | go, optional", version: "one installed version, optional", dir: "the project folder, optional", max: "declarations returned for symbol, default 6" },
  returns: "{package, dir, entry:{type, main, types, bin, exports}, exports:{from, names:{kind:[name]}, count}, symbol:{query, matched, declarations:[{at, signature, doc}]}, readme:{file, intro, headings} or {sections:[{heading, at, text}]}, cite}",
  example: 'await scripts.run("api", { name: "zod", symbol: "safeParse" })',
};

// Top-level public declarations, for the languages with no export list to read.
const TOP = {
  python: /^(?:async\s+)?(def|class)\s+([A-Za-z]\w*)\s*(\([^)]*\)?)?/,
  rust: /^pub\s+(?:(?:async|const|unsafe)\s+)*(fn|struct|enum|trait|mod|type|const|static|use)\s+([^;{(<=]+)/,
  go: /^(func)\s+(?:\([^)]*\)\s*)?([A-Z]\w*)|^(type)\s+([A-Z]\w*)/,
};

export default async function ({ deps }, { name, symbol, topic, eco, version, dir, max = 6 } = {}) {
  if (!name) throw new Error("api needs `name` (the package); the overview script lists what is installed");
  const d = dir ? deps.at(dir) : deps;
  let loc;
  try {
    loc = await d.locate(String(name), { eco, version });
  } catch (e) {
    if (/^not allowed/.test(e.message)) throw e;
    return { package: null, verdict: e.message };
  }
  const o = { eco: loc.eco, version: loc.version };
  const pkg = loc.name;
  const text = (rel) => d.text(pkg, rel, o);
  const all = (await d.files(pkg, { ...o, max: 2000 })).files;
  const out = { package: loc.package, matched: loc.matched, dir: loc.dir, ...(loc.summary ? { summary: loc.summary } : {}), ...(loc.otherVersions ? { otherVersions: loc.otherVersions } : {}) };
  const lang = loc.eco === "npm" ? "ts" : loc.eco === "cargo" ? "rust" : loc.eco;
  let first = []; // the files most likely to hold the public declarations, searched first

  if (loc.eco === "npm" && loc.manifest) {
    out.entry = entryPoints(loc.manifest);
    // Declarations: the package's own, else the entry file.
    let from = null;
    for (const c of typeCandidates(loc.manifest)) {
      if (/\.d\.[cm]?ts$/.test(c) && all.includes(c)) {
        from = c;
        break;
      }
    }
    const main = String(out.entry.exports?.find((r) => r.subpath === ".")?.import ?? out.entry.module ?? out.entry.main ?? "index.js").replace(/^\.\//, "");
    const entry = from ?? [main, main + ".js", main + "/index.js"].find((f) => all.includes(f)) ?? null;
    if (entry) {
      const ex = await exportedNames(text, entry);
      // With a symbol or topic asked for, the full list is left out: the caller wants one thing.
      const cap = symbol || topic ? 40 : 150;
      const groups = {};
      for (const n of ex.names.slice(0, cap)) (groups[n.kind] ??= []).push(n.name);
      const names = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.join(", ")]));
      if ((symbol || topic) && out.entry.exports?.length > 6) {
        out.entry.moreExports = (out.entry.moreExports ?? 0) + out.entry.exports.length - 6;
        out.entry.exports = out.entry.exports.slice(0, 6);
      }
      out.exports = { from: from ? `${entry} (type declarations)` : `${entry} (the entry file; the package ships no type declarations)`, count: ex.names.length, names, ...(ex.names.length > cap ? { more: ex.names.length - cap } : {}), ...(ex.files.length > 1 ? { declaredIn: ex.files.slice(0, 12) } : {}), ...(ex.truncated ? { note: "the export list was cut; look a name up with symbol" } : {}) };
      first = ex.files;
    } else out.exports = { from: null, note: `no entry file found at ${main}; deps.files("${pkg}") lists what is there` };
    if (!from && !all.some((f) => LANGS.ts.files.test(f))) out.types = `no type declarations in the package; if @types/${pkg.replace(/^@/, "").replace("/", "__")} is installed, ask for it by that name`;
  } else if (loc.eco === "python") {
    const mods = loc.modules?.length ? loc.modules : [...new Set(all.filter((f) => !/\.(dist|egg)-info\//.test(f)).map((f) => f.split("/")[0].replace(/\.py$/, "")))];
    out.entry = { modules: mods.slice(0, 20) };
    first = mods.flatMap((m) => [`${m}/__init__.py`, `${m}/__init__.pyi`, `${m}.py`]).filter((f) => all.includes(f));
  } else if (loc.eco === "cargo") {
    first = ["src/lib.rs"].filter((f) => all.includes(f));
    out.entry = { lib: first[0] ?? null };
  } else if (loc.eco === "go") {
    first = all.filter((f) => !f.includes("/") && LANGS.go.files.test(f) && !LANGS.go.skip.test(f));
    out.entry = { import: pkg, rootPackageFiles: first.length, subpackages: [...new Set(all.filter((f) => f.includes("/") && f.endsWith(".go")).map((f) => f.split("/").slice(0, -1).join("/")))].filter((p) => !/(^|\/)(internal|testdata|examples?)(\/|$)/.test(p)).slice(0, 25) };
  }

  if (TOP[loc.eco]) {
    const found = [];
    for (const f of first.slice(0, 40)) {
      const t = await text(f);
      if (!t) continue;
      if (loc.eco === "python") {
        const allNames = /^__all__\s*=\s*[\[(]([^\])]*)/m.exec(t)?.[1];
        if (allNames) out.entry.all = [...allNames.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).slice(0, 80);
        // What the module re-exports from its own submodules: `from .api import get, post` and the bracketed form over several lines.
        const names = [];
        for (const m of t.matchAll(/^from\s+\.[\w.]*\s+import\s+(?:\(([^)]*)\)|([^\n(]+))/gm)) for (const part of (m[1] ?? m[2]).split(",")) {
          const n = part.replace(/#.*$/, "").trim().split(/\s+as\s+/).pop();
          if (/^[A-Za-z]\w*$/.test(n) && !names.includes(n)) names.push(n);
        }
        if (names.length) out.entry.reexports = { [f]: names.slice(0, 100).join(", "), ...(names.length > 100 ? { more: names.length - 100 } : {}) };
      }
      t.split("\n").forEach((line, i) => {
        const m = TOP[loc.eco].exec(line);
        if (!m || (loc.eco === "python" && m[2].startsWith("_"))) return;
        if (found.length < 120) found.push(`${f}:${i + 1}: ${line.trim().replace(/\s*\{?\s*$/, "").slice(0, 160)}`);
      });
    }
    out.exports = { from: first.slice(0, 8), count: found.length, declarations: found.slice(0, 60), ...(found.length > 60 ? { more: found.length - 60 } : {}) };
  }

  if (symbol) {
    const L = LANGS[lang];
    let files = all.filter((f) => L.files.test(f) && !(L.skip?.test(f)));
    let note;
    if (!files.length && L.fallbackFiles) {
      files = all.filter((f) => L.fallbackFiles.test(f) && !L.skip.test(f));
      note = "the package ships no type declarations, so these are from its JavaScript";
    }
    files = [...first.filter((f) => files.includes(f)), ...files.filter((f) => !first.includes(f)).sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1))].slice(0, 600);
    const sym = String(symbol).replace(/^.*[.#]/, "").replace(/\(\)$/, ""); // "z.string()" and "Class#method" mean the last name
    const texts = new Map();
    const started = Date.now();
    let stopped = false;
    let result = null;
    for (const mode of ["exact", "anycase", "contains"]) {
      const quick = mode === "exact" ? (t) => t.includes(sym) : (t) => t.toLowerCase().includes(sym.toLowerCase());
      let decls = [];
      let total = 0;
      for (const f of files) {
        if (Date.now() - started > 8000) {
          stopped = true;
          break;
        }
        if (!texts.has(f)) texts.set(f, (await text(f)) ?? "");
        const t = texts.get(f);
        if (!t || !quick(t)) continue;
        for (const dcl of findDeclarations(t, lang, symbolPattern(sym, mode), { max: 4 })) {
          total++;
          // A declaration with its keyword (function, class, interface, def, fn, func, type) ranks above a member or a property of the same name.
          const keyword = /^\s*(?:(?:export|declare|default|abstract|async|pub(?:\([^)]*\))?|unsafe|const)\s+)*(?:function|class|interface|type|enum|namespace|def|fn|struct|trait|func|macro_rules!)\b/.test(dcl.signature);
          if (decls.length < 60) decls.push({ rank: (keyword ? 0 : 2) + (dcl.doc ? 0 : 1), at: `${f}:${dcl.line}`, signature: dcl.signature, ...(dcl.doc ? { doc: dcl.doc } : {}) });
        }
        if (decls.length >= 60) break;
      }
      if (decls.length) {
        decls.sort((a, b) => a.rank - b.rank);
        // A package that ships index.d.ts, index.d.cts and index.d.mts declares everything three times: keep one.
        const seen = new Set();
        const before = decls.length;
        decls = decls.filter((x) => {
          const key = x.at.replace(/\.d\.[cm]?ts:/, ":") + x.signature;
          return !seen.has(key) && seen.add(key);
        });
        total -= before - decls.length;
        result = { query: symbol, matched: mode === "exact" ? "exact name" : mode === "anycase" ? "the name in another case" : "names containing it", declarations: decls.slice(0, max).map(({ rank, ...x }) => x), ...(total > max ? { more: total - max } : {}) };
        break;
      }
      if (stopped) break;
    }
    out.symbol = result ?? { query: symbol, matched: "none", declarations: [], note: `no declaration of ${sym} in ${files.length} file(s) of ${loc.package}; deps.search("${pkg}", "${sym}") finds every mention` };
    if (note) out.symbol.note = [out.symbol.note, note].filter(Boolean).join("; ");
    if (stopped) out.symbol.partial = "stopped at the time limit; some files were not searched";
  }

  // README: the package's own file; for Python the long description that follows the METADATA headers.
  const readmeFile = all.find((f) => !f.includes("/") && README_FILE.test(f)) ?? (loc.eco === "python" ? all.find((f) => /\.dist-info\/METADATA$/.test(f)) : null);
  if (readmeFile) {
    let t = (await text(readmeFile)) ?? "";
    if (/METADATA$/.test(readmeFile)) t = t.split(/\r?\n\r?\n/).slice(1).join("\n\n");
    if (t.trim()) out.readme = readme(t, readmeFile, { topic });
    else if (topic) out.readme = { file: readmeFile, note: "the package's description is empty" };
  } else if (topic) out.readme = { note: `${loc.package} ships no README${loc.homepage ? `; its homepage is ${loc.homepage}` : ""}` };
  if (!symbol && !topic && out.readme?.headings) out.readme.headings = out.readme.headings.slice(0, 15);
  if (loc.homepage) out.homepage = loc.homepage;
  out.cite = `${loc.package} and the path:line under "at", inside ${loc.dir}`;
  return out;
}
