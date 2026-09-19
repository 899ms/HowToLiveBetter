// README 的结构解析和文件清单：EPUB（tools/epub）和 PDF（tools/pdf）两套构建共用。
// 只认 README 里的结构，不维护文件名单——新增一节或一篇长文，两套构建都自动跟上。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REPO = 'https://github.com/eternity4719/HowToLiveBetter';
export const SITE = 'https://eternity4719.github.io/HowToLiveBetter/';
export const TITLE = '高性价比人生指南';
export const RELEASE = `${REPO}/releases/download/epub-latest`;

export const read = p => readFileSync(resolve(ROOT, p), 'utf8');
export const unique = arr => [...new Set(arr)];

export function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return process.env.GITHUB_SHA ?? '';
  }
}

export function stripBackLink(md) {
  return md.replace(/^\[← 回总目录\]\([^)]*\)\s*\n/, '');
}

// README 里从某个标题到下一个标题之间的一段
export function readBook() {
  const readme = read('README.md');
  const lines = readme.split('\n');
  const between = (from, to) => {
    const a = lines.findIndex(l => l.startsWith(from));
    const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
    if (a < 0 || b < 0) throw new Error(`README 里找不到 ${from} 到 ${to} 这一段`);
    return lines.slice(a, b).join('\n');
  };
  const description = between('# 高性价比人生指南', '[![')
    .split('\n').slice(1).map(l => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join('');
  const frontMd = between('## 这本书想回答的问题', '## 目录');
  const contentsMd = between('## 目录', '## 正文')
    .split('\n\n').filter(p => !p.includes('index.html')).join('\n\n');
  const bookFiles = unique([...contentsMd.matchAll(/\]\((book\/[^)#]+\.md)\)/g)].map(m => m[1]));
  const docFiles = unique([...readme.matchAll(/\]\((docs\/[^)#/]+\.md)\)/g)].map(m => m[1]));
  if (bookFiles.length === 0) throw new Error('README 目录里没找到 book/ 文件');
  return { readme, description, frontMd, contentsMd, bookFiles, docFiles };
}
