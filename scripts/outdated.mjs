import { compareVersions, pool, step } from "../lib/util.mjs";

export const meta = {
  purpose:
    "Which direct dependencies are behind? For each: the installed version, the highest version the declared range allows (wanted), the latest release, and whether the step to latest is patch, minor or major. Asks the public registry (npm, PyPI, crates.io index, Go proxy); when it cannot be reached the result says so.",
  params: { eco: "npm | python | cargo | go, optional (default: every ecosystem found)", dir: "the project folder, optional", all: "also list the ones that are up to date, default false", max: "dependencies checked, default 80" },
  returns: "{ok, checked, behind:[{eco, name, current, declared, wanted, latest, step, kind, deprecated}], upToDate, unknown:[{name, why}], counts:{major, minor, patch}, verdict}",
  example: 'await scripts.run("outdated", {})',
};

export default async function ({ deps }, { eco, dir, all = false, max = 80 } = {}) {
  const d = dir ? deps.at(dir) : deps;
  const rows = (await d.direct(eco ? { eco } : {})).filter((r) => !r.workspace);
  if (!rows.length) return { ok: true, checked: 0, behind: [], upToDate: 0, unknown: [], counts: {}, verdict: "the project declares no dependencies" };
  const list = rows.slice(0, max);
  const got = await pool(list, 8, (r) => d.registry(r.name, { eco: r.eco, range: r.declared }));
  const behind = [];
  const current = [];
  const unknown = [];
  list.forEach((r, i) => {
    const g = got[i];
    if (!g.ok) return unknown.push({ eco: r.eco, name: r.name, why: g.error });
    const cur = r.version;
    const s = cur ? step(cur, g.latest) : null;
    const row = { eco: r.eco, name: r.name, current: cur ?? "(not installed)", declared: r.declared, wanted: g.wanted ?? null, latest: g.latest, step: s ?? (cur ? "unknown" : "not installed"), ...(r.kind !== "prod" ? { kind: r.kind } : {}), ...(g.deprecated ? { deprecated: g.deprecated } : {}), ...(r.deprecated ? { installedIsDeprecated: r.deprecated } : {}) };
    if (cur && g.wanted && compareVersions(g.wanted, cur) > 0) row.withinRange = step(cur, g.wanted);
    if (!cur || (s && s !== "none")) behind.push(row);
    else current.push(row);
  });
  const offline = unknown.length === list.length && unknown.every((u) => /could not reach/.test(u.why ?? ""));
  if (offline) return { ok: false, checked: 0, behind: [], unknown: unknown.slice(0, 3), verdict: `the registry could not be reached (${unknown[0].why}), so nothing is known about newer versions. Installed versions are in the overview script` };
  const order = { major: 0, "minor (0.x, may break)": 1, minor: 2, patch: 3, prerelease: 4 };
  behind.sort((a, b) => (order[a.step] ?? 9) - (order[b.step] ?? 9) || (a.name < b.name ? -1 : 1));
  const counts = {};
  for (const b of behind) counts[b.step] = (counts[b.step] ?? 0) + 1;
  return {
    ok: true,
    checked: list.length - unknown.length,
    behind,
    upToDate: current.length,
    ...(all ? { current } : {}),
    unknown: unknown.slice(0, 20),
    ...(rows.length > max ? { notChecked: rows.length - max } : {}),
    counts,
    verdict: `${behind.length} of ${list.length - unknown.length} direct dependencies are behind${behind.length ? ` (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}${unknown.length ? `; ${unknown.length} could not be checked` : ""}`,
  };
}
