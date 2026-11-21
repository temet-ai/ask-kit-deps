import { satisfies, parseVersion } from "../lib/util.mjs";

export const meta = {
  purpose:
    "What does this project depend on? The ecosystems found (npm, pnpm or yarn, Python, Cargo, Go), the package manager and its version, every direct dependency with its declared range and installed version, the counts, and what is inconsistent: declared but not installed, installed outside the declared range, two major versions of one package, deprecated or extraneous packages.",
  params: { eco: "npm | python | cargo | go, optional (default: every ecosystem found)", dir: "the project folder, relative to the caller's folder, optional", max: "direct dependencies listed, default 80" },
  returns: "{root, ecosystems:[{eco, root, packageManager, manifests, lockfiles, readFrom, installed, direct, transitive, packages}], direct:[{eco, name, declared, version, kind}], problems:[text], verdict}",
  example: 'await scripts.run("overview", {})',
};

export default async function ({ deps }, { eco, dir, max = 80 } = {}) {
  const d = dir ? deps.at(dir) : deps;
  const p = await d.project();
  if (!p.ecosystems.length) return { root: null, ecosystems: [], direct: [], problems: [], verdict: p.note };
  const rows = await d.direct(eco ? { eco } : {});
  const all = await d.installed(eco ? { eco, max: 1000 } : { max: 1000 });
  const named = new Set(all.readFrom.map((x) => x.split(":")[0]));
  const ecosystems = p.ecosystems.filter((e) => named.has(e.eco));
  const problems = [];
  for (const e of ecosystems) for (const n of e.notes ?? []) problems.push(`${e.eco}: ${n}`);

  const missing = rows.filter((r) => r.version === null);
  if (missing.length) problems.push(`declared but not installed: ${missing.slice(0, 20).map((r) => `${r.name} ${r.declared} (${r.eco}, ${r.from})`).join("; ")}${missing.length > 20 ? ` and ${missing.length - 20} more` : ""}`);
  const off = rows.filter((r) => r.version && (r.eco === "npm" || r.eco === "cargo") && satisfies(r.version, r.eco === "cargo" && /^\d/.test(r.declared) ? "^" + r.declared : r.declared) === false);
  if (off.length) problems.push(`installed outside the declared range: ${off.slice(0, 20).map((r) => `${r.name} is ${r.version}, declared ${r.declared}`).join("; ")}`);

  const byName = new Map();
  for (const x of all.packages) (byName.get(`${x.eco} ${x.name}`) ?? byName.set(`${x.eco} ${x.name}`, []).get(`${x.eco} ${x.name}`)).push(x);
  const majors = [];
  for (const list of byName.values()) {
    const m = new Set(list.map((x) => parseVersion(x.version)?.nums[0]));
    if (m.size > 1) majors.push(`${list[0].name} (${[...new Set(list.map((x) => x.version))].join(", ")})`);
  }
  if (majors.length) problems.push(`two or more major versions of one package: ${majors.slice(0, 15).join("; ")}${majors.length > 15 ? ` and ${majors.length - 15} more` : ""}`);
  const deprecated = all.packages.filter((x) => x.deprecated);
  if (deprecated.length) problems.push(`deprecated: ${deprecated.slice(0, 10).map((x) => `${x.name}@${x.version} (${x.deprecated.slice(0, 80)})`).join("; ")}${deprecated.length > 10 ? ` and ${deprecated.length - 10} more` : ""}`);
  const extraneous = all.packages.filter((x) => String(x.through ?? "").includes("extraneous"));
  if (extraneous.length) problems.push(`installed but required by nothing: ${extraneous.slice(0, 10).map((x) => `${x.name}@${x.version}`).join(", ")}${extraneous.length > 10 ? ` and ${extraneous.length - 10} more` : ""}`);

  const shown = rows.slice(0, max).map((r) => ({ eco: r.eco, name: r.name, declared: r.declared, version: r.version, kind: r.kind, ...(r.from !== "package.json" && r.eco === "npm" ? { from: r.from } : {}) }));
  return {
    root: p.root,
    ecosystems: ecosystems.map((e) => ({ eco: e.eco, root: e.root, project: [e.project?.name, e.project?.version].filter(Boolean).join("@") || null, packageManager: `${e.packageManager.name}${e.packageManager.version ? " " + e.packageManager.version : " (not on PATH)"}${e.packageManager.declared ? `, package.json asks for ${e.packageManager.declared}` : ""}`, manifests: e.manifests, lockfiles: e.lockfiles, readFrom: e.readFrom, installed: e.installed, direct: e.direct.total, devDirect: e.direct.dev, transitive: e.transitive, packages: e.packages })),
    direct: shown,
    ...(rows.length > max ? { moreDirect: rows.length - max } : {}),
    problems,
    verdict: `${ecosystems.map((e) => `${e.eco} (${e.packageManager.name}): ${e.direct.total} direct, ${e.transitive} transitive`).join("; ")}; ${problems.length ? `${problems.length} thing(s) to look at` : "nothing inconsistent"}`,
  };
}
