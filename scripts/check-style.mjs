// 行宽棘轮：不允许「新增」超长行，但不阻止修改既有长行。
//
// 判定方式是按文件比较数量，而不是逐行配对：
//   addedLong(file) > removedLong(file)  → 失败
//
// 这样改一行既有长行（长度不变）可以通过，而新写一条 300 字符的长行会被拦下。
// 整体格式化的提交会让计数下降，同样通过。
//
// 用法：
//   node scripts/check-style.mjs              # 与 HEAD 比较工作区改动
//   node scripts/check-style.mjs <base-ref>   # 与 base 比较（CI 用，三点 diff）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX = 200;
const ALLOW = 'style-allow-long-line';
const base = process.argv[2];

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const range = base ? [`${base}...HEAD`] : [];

let diff;
try {
  diff = git(['diff', '--unified=0', '--no-color', ...range, '--', '*.js', '*.mjs', '*.html', '*.css']);
} catch (err) {
  // 基线不可用时只提示，不阻断：不能因为 CI 环境拿不到 ref 就卡住合并
  console.log(`⚠️  无法计算 diff（${err.message.split('\n')[0]}），跳过行宽检查`);
  process.exit(0);
}

if (!diff.trim()) {
  console.log('✅ 没有代码改动，行宽检查通过');
  process.exit(0);
}

const added = new Map();
const removed = new Map();
let file = null;
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
  if (line.startsWith('--- a/')) continue;
  if (!file) continue;

  if (line.startsWith('+') && !line.startsWith('+++')) {
    const body = line.slice(1);
    if (body.length > MAX && !body.includes(ALLOW)) bump(added, file);
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    if (line.slice(1).length > MAX) bump(removed, file);
  }
}

// git diff 不包含未跟踪的新文件，本地模式单独扫一遍；CI 里新文件会作为 added 出现，无需重复
if (!base) {
  let untracked = '';
  try {
    untracked = git(['ls-files', '--others', '--exclude-standard', '--', '*.js', '*.mjs', '*.html', '*.css']);
  } catch { untracked = ''; }
  for (const f of untracked.split('\n').filter(Boolean)) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.length > MAX && !line.includes(ALLOW)) bump(added, f);
    }
  }
}

const failures = [];
for (const [f, count] of added) {
  const before = removed.get(f) || 0;
  if (count > before) failures.push({ file: f, added: count, removed: before });
}
const files = [...new Set([...added.keys(), ...removed.keys()])].sort();
if (files.length) {
  console.log(`行宽上限 ${MAX} 字符：`);
  for (const f of files) {
    console.log(`  ${f.padEnd(24)} 新增超长 ${String(added.get(f) || 0).padStart(3)}  移除超长 ${String(removed.get(f) || 0).padStart(3)}`);
  }
}

if (failures.length) {
  console.error('\n❌ 新增了超长行。请断行，或在该行加上注释 ' + ALLOW + ' 说明理由：');
  for (const f of failures) console.error(`  ${f.file}: 新增 ${f.added} 行超过 ${MAX} 字符，仅移除 ${f.removed} 行`);
  process.exit(1);
}

console.log('\n✅ 行宽检查通过（未新增超长行）');
