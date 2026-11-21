export const meta = {
  purpose:
    "Which licences do the installed packages carry? Counts by licence, and the packages to look at: no licence stated, copyleft (GPL, AGPL, LGPL, MPL, EPL and the like), or unusual (not one of the common permissive licences).",
  params: { eco: "npm | python | cargo | go, optional (default: every ecosystem found)", dir: "the project folder, optional", prod: "leave out dev-only packages, default false", max: "packages listed per group, default 40" },
  returns: "{total, counts:[{licence, packages}], missing:[name@version], copyleft:[{package, licence, direct}], unusual:[{package, licence}], verdict}",
  example: 'await scripts.run("licences", { prod: true })',
};

const PERMISSIVE = /^(MIT(-0)?|ISC|BSD(-[0-4]-Clause(-Clear|-Patent)?)?|0BSD|Apache(-2\.0| 2\.0| License 2\.0|2)?|Unlicense|CC0(-1\.0)?|CC-BY-[34]\.0|BlueOak-1\.0\.0|Python-2\.0(\.1)?|PSF(-2\.0)?|Zlib|WTFPL|Unicode-(DFS-2016|3\.0)|BSL-1\.0|MIT License|BSD License|Apache Software License|ISC License( \(ISCL\))?|Python Software Foundation License|The Unlicense( \(Unlicense\))?|Public Domain|MIT No Attribution License \(MIT-0\))$/i;
const COPYLEFT = /\b(A?GPL|LGPL|GNU (Affero |Lesser |Library )?General Public|MPL|Mozilla Public|EPL|Eclipse Public|CDDL|EUPL|OSL|SSPL|CC-BY-(NC|SA|ND)|CECILL|RPL|Sleepycat)/i;

// An SPDX expression: `A OR B` is satisfied by either, `A AND B` needs both.
function classify(licence) {
  if (!licence) return "missing";
  const ors = String(licence).replace(/[()]/g, " ").split(/\s+OR\s+|\s*\/\s*/i);
  const kinds = ors.map((alt) => {
    const parts = alt.split(/\s+AND\s+/i).map((s) => s.trim().replace(/\s+WITH\s+.*$/i, "").replace(/\+$/, "")).filter(Boolean);
    if (parts.some((x) => COPYLEFT.test(x))) return "copyleft";
    return parts.every((x) => PERMISSIVE.test(x)) ? "permissive" : "unusual";
  });
  return kinds.includes("permissive") ? "permissive" : kinds.includes("unusual") ? "unusual" : "copyleft";
}

export default async function ({ deps }, { eco, dir, prod = false, max = 40 } = {}) {
  const d = dir ? deps.at(dir) : deps;
  let rows = await d.licences(eco ? { eco } : {});
  if (prod) rows = rows.filter((r) => !r.dev);
  if (!rows.length) return { total: 0, counts: [], missing: [], copyleft: [], unusual: [], verdict: "no installed packages were found; the overview script says why" };
  const counts = new Map();
  const groups = { missing: [], copyleft: [], unusual: [] };
  for (const r of rows) {
    counts.set(r.licence ?? "(none stated)", (counts.get(r.licence ?? "(none stated)") ?? 0) + 1);
    const k = classify(r.licence);
    if (k === "missing") groups.missing.push(`${r.name}@${r.version}`);
    else if (k !== "permissive") groups[k].push({ package: `${r.name}@${r.version}`, licence: String(r.licence).slice(0, 80), ...(r.direct ? { direct: true } : {}), ...(r.dev ? { dev: true } : {}), ...(r.from ? { from: r.from } : {}) });
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([licence, packages]) => ({ licence: licence.slice(0, 80), packages }));
  const cut = (list) => (list.length > max ? [...list.slice(0, max), `and ${list.length - max} more`] : list);
  return {
    total: rows.length,
    counts: sorted.slice(0, 25),
    ...(sorted.length > 25 ? { moreLicences: sorted.length - 25 } : {}),
    missing: cut(groups.missing),
    copyleft: cut(groups.copyleft),
    unusual: cut(groups.unusual),
    verdict: `${rows.length} packages${prod ? " (dev-only left out)" : ""}: ${sorted.slice(0, 4).map((c) => `${c.packages} ${c.licence}`).join(", ")}${sorted.length > 4 ? ", ..." : ""}; ${groups.copyleft.length} copyleft, ${groups.missing.length} with no licence stated, ${groups.unusual.length} unusual`,
  };
}
