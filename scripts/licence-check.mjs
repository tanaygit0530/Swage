#!/usr/bin/env node
// Licence check of every dependency (blueprint section 13; problem statement rules 3 to 7).
// Production dependencies are bundled into the extension, so they must be permissive; dev
// dependencies only build and test it and are listed for information. Exit code 1 if a
// production dependency is copyleft, unknown or unlicensed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const PERMISSIVE =
  /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|BlueOak-1\.0\.0|Unlicense|CC0-1\.0|Python-2\.0|CC-BY-4\.0|MIT-0|Zlib)$/;

function licenceOf(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let lic = pkg.license ?? pkg.licenses;
  if (Array.isArray(lic)) lic = lic.map((l) => l.type ?? l).join(' OR ');
  if (lic && typeof lic === 'object') lic = lic.type;
  return { name: pkg.name, version: pkg.version, licence: lic ? String(lic) : 'UNKNOWN' };
}

/** True when every alternative of an SPDX expression ("MIT OR Apache-2.0", "(MIT AND Zlib)") is permissive enough. */
function ok(expr) {
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (/ OR /i.test(clean)) return clean.split(/ OR /i).some((p) => ok(p));
  return clean.split(/ AND /i).every((p) => PERMISSIVE.test(p.trim()));
}

function list(args) {
  let text;
  try {
    text = execFileSync('npm', ['ls', '--all', '--parseable', ...args], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch (err) {
    text = err.stdout ?? '';
  }
  const root = process.cwd();
  return [
    ...new Set(
      text.split('\n').filter((d) => d && d !== root && existsSync(path.join(d, 'package.json'))),
    ),
  ].map(licenceOf);
}

const prod = list(['--omit=dev']);
const prodKeys = new Set(prod.map((p) => `${p.name}@${p.version}`));
const dev = list([]).filter((p) => !prodKeys.has(`${p.name}@${p.version}`));

const count = (xs) => {
  const m = new Map();
  for (const x of xs) m.set(x.licence, (m.get(x.licence) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(', ');
};
console.log(`Production dependencies (bundled into the extension): ${prod.length} packages`);
console.log(`  ${count(prod)}`);
console.log(`Dev dependencies (build and test only): ${dev.length} packages`);
console.log(`  ${count(dev)}`);
const bad = prod.filter((p) => !ok(p.licence));
const devNote = dev.filter((p) => !ok(p.licence));
for (const p of devNote)
  console.log(`  note (dev only, not shipped): ${p.name}@${p.version} ${p.licence}`);
if (bad.length) {
  for (const p of bad) console.log(`  PROBLEM (shipped): ${p.name}@${p.version} ${p.licence}`);
  process.exit(1);
}
console.log('Every shipped dependency has a permissive licence.');
