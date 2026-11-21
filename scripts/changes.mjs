import { CHANGELOG_FILE, changelogEntries, changesBetween } from "../lib/api.mjs";
import { clip, compareVersions } from "../lib/util.mjs";

export const meta = {
  purpose:
    "What changed in a package between two versions, from the CHANGELOG the installed copy ships? The entries above `from` up to `to` (default: the installed version), newest first; with no `from`, the last three entries. Says so when the package ships no changelog. Use it before or after an upgrade, for breaking changes.",
  params: { name: "the package", from: "the version you are coming from (its entry is left out), optional", to: "the newest version wanted, default the installed version", eco: "npm | python | cargo | go, optional", version: "one installed version, optional", dir: "the project folder, optional", max: "entries returned, default 10" },
  returns: "{package, ships, file, from, to, entries:[{version, date, at, text}], more, newerThanInstalled, versionsInFile, verdict}",
  example: 'await scripts.run("changes", { name: "@ankh-morpork/watch", from: "1.9.3" })',
};

export default async function ({ deps }, { name, from, to, eco, version, dir, max = 10 } = {}) {
  if (!name) throw new Error("changes needs `name` (the package)");
  const d = dir ? deps.at(dir) : deps;
  let loc;
  try {
    loc = await d.locate(String(name), { eco, version });
  } catch (e) {
    if (/^not allowed/.test(e.message)) throw e;
    return { package: null, ships: false, entries: [], verdict: e.message };
  }
  const o = { eco: loc.eco, version: loc.version };
  const files = (await d.files(loc.name, { ...o, max: 2000 })).files;
  const file = files.find((f) => !f.includes("/") && CHANGELOG_FILE.test(f)) ?? files.find((f) => f.split("/").length === 2 && /^docs?\//i.test(f) && CHANGELOG_FILE.test(f.split("/")[1]));
  const where = loc.manifest?.repository ?? loc.homepage ?? null;
  if (!file) return { package: loc.package, ships: false, entries: [], ...(where ? { lookAt: where } : {}), verdict: `${loc.package} ships no changelog in its installed files${where ? `; its repository or homepage is ${where}` : ""}` };
  const text = (await d.text(loc.name, file, o)) ?? "";
  const entries = changelogEntries(text);
  if (!entries.length) return { package: loc.package, ships: true, file, entries: [], head: clip(text, 1200), verdict: `${file} has no version headings this script recognises; its first lines are in head, and deps.read("${loc.name}", "${file}") reads the rest` };
  const upTo = to ?? loc.version;
  const { picked, newer } = changesBetween(entries, { from, to: upTo, last: 3 });
  let budget = 9000;
  const shown = [];
  for (const e of picked.slice(0, max)) {
    const t = clip(e.text, Math.min(1500, Math.max(300, budget)));
    budget -= t.length;
    shown.push({ version: e.version, ...(e.date ? { date: e.date } : {}), at: `${file}:${e.line}`, text: t });
    if (budget <= 0) break;
  }
  const known = entries.map((e) => e.version);
  const fromKnown = !from || known.includes(String(from).replace(/^v/, ""));
  return {
    package: loc.package,
    ships: true,
    file,
    from: from ?? null,
    to: upTo,
    entries: shown,
    ...(picked.length > shown.length ? { more: picked.length - shown.length } : {}),
    ...(newer ? { newerThanInstalled: newer } : {}),
    versionsInFile: known.length > 14 ? [...known.slice(0, 12), `and ${known.length - 12} more`] : known,
    verdict: `${shown.length ? `${picked.length} entr${picked.length === 1 ? "y" : "ies"} ${from ? `above ${from} up to ${upTo}` : `up to ${upTo} (the last ${picked.length})`} in ${loc.package} ${file}` : `no entries ${from ? `above ${from} ` : ""}up to ${upTo} in ${file}; its newest entry is ${[...known].sort((a, b) => compareVersions(b, a))[0]}`}${fromKnown ? "" : `; ${from} has no entry of its own, so the range starts at the next version above it`}${/breaking/i.test(shown.map((e) => e.text).join("\n")) ? "; the word 'breaking' appears" : ""}`,
  };
}
