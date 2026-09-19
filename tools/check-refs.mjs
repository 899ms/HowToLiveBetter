// 交叉引用对照表：把正文里每一处「第 X 条」引用解析成它实际指向的条目标题，
// 写进 docs/引用对照.md。那份文件入库，所以插入或删除条目导致引用指向变化时，
// git diff 会直接把变化摆出来——条号没动而标题变了，就是错位。
//
//   node tools/check-refs.mjs            # 重新生成对照表（sync-stats.ps1 末尾会自动调用）
//   node tools/check-refs.mjs --check    # 只校验不写文件，有失效引用则退出码 1（CI 用）
//   node tools/check-refs.mjs --suspect  # 额外列出措辞和目标标题对不上的，误报多，排查历史遗留时用
//
// 为什么需要它：条号是位置依赖的，正文里的引用只记了位置不记内容。2026-09-19
// 在第 7 节发现 6 处指错（医疗救助指到低保、救助站指错条），全都在条号范围内，
// 越界检查一条都抓不到。
// 注意：切行一律用 /\r?\n/，不能用 '\n'。book/ 下的文件行尾不统一（有 CRLF 有 LF），
// 而 JS 正则的 . 不匹配 \r（CR 也算行终止符，这点和 Python、Perl 不一样），
// 留着 \r 会让 /^### (\d+)\. (.*)$/ 在 CRLF 文件上一条都匹配不到。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ONLY = process.argv.includes('--check');

// 节内的裸引用（「见第 8 条」）只在这几个栏位里找：来源栏里的「第 N 条」几乎都是
// 法条条款号，扫进来全是误报。
const FIELDS = /^- (说人话|收益|备注|成本)：/;
// 但带节号的跨节引用（「见第 11 节第 16 条」）不会和法条混淆，来源栏里也有，一并扫。
// book/26 第 103 条那处「日志留存见第 11 节第 16 条」就写在来源栏里，差点漏掉。
const CROSS_FIELDS = /^- (说人话|收益|备注|成本|来源)：/;

const files = readdirSync(resolve(ROOT, 'book')).filter(f => /^\d\d-.*\.md$/.test(f)).sort();

// 先把每节的条目标题读出来：sections[节号] = { file, titles: { 条号: 标题 } }
const sections = new Map();
for (const f of files) {
  const num = Number(f.slice(0, 2));
  const titles = new Map();
  for (const line of readFileSync(resolve(ROOT, 'book', f), 'utf8').split(/\r?\n/)) {
    const m = /^### (\d+)\. (.*)$/.exec(line);
    if (m) titles.set(Number(m[1]), m[2].trim());
  }
  sections.set(num, { file: f, titles });
}

// 一处引用可能写成「第 3、10、11 条」，拆成多个条号
const nums = s => s.split(/[、,]/).map(x => Number(x.trim())).filter(n => Number.isFinite(n));

const out = [];
const problems = [];
const suspects = [];
let total = 0;

for (const f of files) {
  const num = Number(f.slice(0, 2));
  const self = sections.get(num);
  const lines = readFileSync(resolve(ROOT, 'book', f), 'utf8').split(/\r?\n/);
  const rows = [];
  let cur = 0;

  // 引用前面那句话往往就写着它想指什么（「医疗救助（见第 11 条）」），把整个分句
  // 列出来，人工扫对照表时不用翻正文就能判断指对没有。
  // 取到最近的句读为界而不是固定字数——固定 14 字曾让好几处正确引用看起来可疑
  // （「一氧化碳见第 18 条，烧烫伤见第 13 条」截断后只剩「氧化碳」对着「烫伤」）。
  const ctxOf = (line, idx) => {
    const before = line.slice(0, idx);
    let start = -1;
    for (const p of ['。', '；', '！', '？', '：']) start = Math.max(start, before.lastIndexOf(p));
    return before.slice(start + 1).slice(-44).replace(/\|/g, '｜');
  };

  lines.forEach((line, i) => {
    const t = /^### (\d+)\./.exec(line);
    if (t) { cur = Number(t[1]); return; }
    if (!CROSS_FIELDS.test(line)) return;

    // 跨节：第 N 节第 X 条
    for (const m of line.matchAll(/第\s*(\d+)\s*节第\s*([\d、,\s]+?)\s*条/g)) {
      const target = sections.get(Number(m[1]));
      for (const x of nums(m[2])) {
        const title = target?.titles.get(x);
        rows.push({ from: cur, ref: `第 ${m[1]} 节第 ${x} 条`, title, line: i + 1, ctx: ctxOf(line, m.index) });
        if (!title) problems.push(`${f}:${i + 1} 第 ${cur} 条引用「第 ${m[1]} 节第 ${x} 条」——该节没有这一条`);
      }
    }

    // 节内：扫所有「第 X 条」，不限引导词——正文里的写法远不止「见第 X 条」，还有
    // 「按第 1 条压胸」「判断方法同第 4 条」「先对照第 8 条」「和第 4 条二选一」，
    // 早先只认三种引导词，这些全漏在扫描之外。来源栏整行不扫（全是法条条款号）。
    if (!FIELDS.test(line)) return;
    const stripped = line.replace(/第\s*\d+\s*节第\s*[\d、,\s]+?\s*条/g, '');
    for (const m of stripped.matchAll(/第\s*([\d、,\s]+?)\s*条/g)) {
      // 前面十几个字里出现法规名或文号的，是法条条款号不是条目引用，跳过
      const pre = stripped.slice(Math.max(0, m.index - 16), m.index);
      if (/法|条例|办法|规定|准则|解释|细则|号〕|〕|号，|公约|宪法/.test(pre)) continue;
      for (const x of nums(m[1])) {
        const title = self.titles.get(x);
        rows.push({ from: cur, ref: `本节第 ${x} 条`, title, line: i + 1, ctx: ctxOf(stripped, m.index) });
        // 节内引用超出本节条目数的，多半是法条条款号被误当成条目引用，列出来人工看
        if (!title) problems.push(`${f}:${i + 1} 第 ${cur} 条引用「第 ${x} 条」——本节只有 ${self.titles.size} 条（可能是法条条款号）`);
        if (x === cur) problems.push(`${f}:${i + 1} 第 ${cur} 条引用了它自己`);
      }
    }
  });

  // 启发式查错位：引用紧挨着的那几个字通常就是它想指的东西（「医疗救助（见第 11 条）」），
  // 若这几个字和目标标题连两个字都对不上，多半指错了，列出来人工看。会有误报
  // （引用前是「见」「参见」这类虚词时），但能把 288 处缩小到十几处。
  for (const r of rows) {
    if (!r.title) continue;
    const tail = r.ctx.slice(-8);
    let hit = false;
    for (let i = 0; i + 2 <= tail.length && !hit; i++) {
      const bg = tail.slice(i, i + 2);
      if (/^[一-龥]{2}$/.test(bg) && r.title.includes(bg)) hit = true;
    }
    if (!hit) suspects.push(`${f}:${r.line} 第 ${r.from} 条 →「${r.ref}」${r.title.slice(0, 22)}…　上下文：…${r.ctx}…`);
  }

  if (!rows.length) continue;
  total += rows.length;
  out.push(`## ${basename(f, '.md')}\n`);
  out.push('| 出处 | 引用 | 指向的条目 | 引用处的上下文 |');
  out.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    const title = r.title ? r.title : '**指向不存在的条目**';
    out.push(`| 第 ${r.from} 条 | ${r.ref} | ${title} | …${r.ctx}… |`);
  }
  out.push('');
}

const body = [
  '# 交叉引用对照表',
  '',
  '本文件由 `node tools/check-refs.mjs` 生成，不要手改。',
  '',
  '正文里的「第 X 条」只记条号不记内容，插入或删除条目会让后面的引用集体错位，',
  '而错位后的条号往往仍在范围内，光查越界抓不到。所以把每处引用**实际指向的标题**',
  '摊开写在这里并入库：改完条目重新生成，`git diff` 里凡是条号没动而标题变了的，',
  '就是被顺延撞歪的引用。',
  '',
  `共 ${total} 处引用。`,
  '',
  ...out,
].join('\n');

if (problems.length) {
  console.log('需要人工确认：');
  for (const p of problems) console.log('  ' + p);
  console.log('');
}

// 这个启发式误报率极高（中文里「未遂之后的长期结局见第 30 条」指向「念头一冒出来
// 先告诉身边的一个人」完全正确，却一个字都不重叠），288 处能报出 159 处，没有筛选
// 价值，所以默认不输出，只留给一次性人工排查用。真正靠得住的是下面那张对照表的 diff。
if (process.argv.includes('--suspect') && suspects.length) {
  console.log(`引用处的措辞和目标标题对不上（${suspects.length} 处，误报很多，仅供人工排查参考）：`);
  for (const s of suspects) console.log('  ' + s);
  console.log('');
}

if (CHECK_ONLY) {
  const fatal = problems.filter(p => p.includes('该节没有这一条') || p.includes('引用了它自己'));
  console.log(fatal.length ? `发现 ${fatal.length} 处失效引用` : '引用检查通过');
  process.exit(fatal.length ? 1 : 0);
}

writeFileSync(resolve(ROOT, 'docs/引用对照.md'), body, 'utf8');
console.log(`已写入 docs/引用对照.md，共 ${total} 处引用`);
