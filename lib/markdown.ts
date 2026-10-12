import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import katex from 'katex';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { docsPath } from './cache';

// 这些插件未自带类型声明，这里做模块声明以消除 TS 报错
declare module 'markdown-it-admonition';
declare module 'markdown-it-anchor';
declare module 'markdown-it-footnote';
declare module 'markdown-it-emoji';
declare module 'markdown-it-emoji/';
declare module 'markdown-it-task-lists';
declare module 'markdown-it-abbr';
declare module 'markdown-it-mark';
declare module 'markdown-it-sup';
declare module 'markdown-it-sub';

// @ts-ignore - 无类型声明的插件
import admonition from 'markdown-it-admonition';
// @ts-ignore
import anchor from 'markdown-it-anchor';
// @ts-ignore
import footnote from 'markdown-it-footnote';
// @ts-ignore
import * as emoji from 'markdown-it-emoji';
// @ts-ignore
import taskLists from 'markdown-it-task-lists';
// @ts-ignore
import abbr from 'markdown-it-abbr';
// @ts-ignore
import mark from 'markdown-it-mark';
// @ts-ignore
import sup from 'markdown-it-sup';
// @ts-ignore
import sub from 'markdown-it-sub';

function highlightCode(str: string, lang: string): string {
    // mermaid 图交给前端 mermaid.run 处理，这里只原样转义保留
    if (lang === 'mermaid') return `<pre class="mermaid">${MarkdownIt().utils.escapeHtml(str)}</pre>`;
    let code: string;
    if (lang && hljs.getLanguage(lang)) {
        try {
            code = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch {
            code = MarkdownIt().utils.escapeHtml(str);
        }
    } else {
        code = MarkdownIt().utils.escapeHtml(str);
    }
    return `<pre class="hljs"><code>${code}</code></pre>`;
}

const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight: highlightCode,
});

// Material 键盘键语法：++ctrl+alt+del++ → 多个 <kbd> 用 + 连接
// 注意：内容必须形如 ctrl+alt+del（仅 ASCII 字母/数字/下划线/连字符/加号），
// 否则正文里的 C++ / g++ / clang++ 会被误判成一对 ++ 定界符，把整段文字吞进 <kbd>。
function materialKeys(md: MarkdownIt): void {
    md.inline.ruler.before('emphasis', 'material_keys', (state, silent) => {
        const start = state.pos;
        if (state.src.slice(start, start + 2) !== '++') return false;
        const end = state.src.indexOf('++', start + 2);
        if (end === -1 || end === start + 2) return false;
        const content = state.src.slice(start + 2, end);
        if (!/^[A-Za-z0-9_+-]+$/.test(content)) return false;
        if (content.startsWith('+') || content.endsWith('+') || content.includes('++')) return false;
        if (!silent) {
            const html = content.split('+').map((k) => `<kbd>${md.utils.escapeHtml(k)}</kbd>`).join('<kbd>+</kbd>');
            const t = state.push('html_inline', '', 0);
            t.content = html;
        }
        state.pos = end + 2;
        return true;
    });
}

// 部分插件默认导出为 { default: fn }，统一取真实函数
function plug(p: any): any {
    return p && typeof p === 'object' && typeof p.default === 'function' ? p.default : p;
}

// 与 OI Wiki 原站 pymdownx.slugs.uslugify 一致的标题 slug：
// 小写、空白转 -、丢弃其余非标点字符（保留 Unicode 字母/数字/下划线）。
// 文档内 200+ 处中文锚链接（](#函数对象)）依赖该规则，默认 slugify 会丢掉中文。
function uslugify(s: string): string {
    return s.trim().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_-]+/gu, '');
}

md.use(admonition);
md.use(anchor, {
    slugify: (s: string) => uslugify(String(s)),
    // 重复标题去重后缀 _1 / _2 与 markdown-it-anchor 默认行为一致，
    // 恰好匹配原站 python-markdown toc 的规则（见 dp/plug.md #例题_2）。
});
md.use(footnote);
md.use(emoji.full);
md.use(plug(abbr));
md.use(plug(mark));
md.use(plug(sup));
md.use(plug(sub));
md.use(plug(taskLists), { enabled: true, label: true });
md.use(materialKeys as any);

// ---------------- KaTeX 数学渲染 ----------------
// 直接使用 katex 0.16 渲染，HTML 结构与页面加载的 katex 0.16 CSS 严格匹配。
// 此前的 markdown-it-katex 内置的是 KaTeX 0.6（2016 年），其输出类名
// （vlist 平铺、baseline-fix 等）在 0.16 CSS 中无对应样式，导致上下标错位。
function renderMath(tex: string, displayMode: boolean): string {
    return katex.renderToString(tex, { displayMode, throwOnError: false, strict: false, trust: true });
}

// 行内公式：$...$ 与行内 $$...$$；内容支持 \ 转义
function mathInlineRule(state: any, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos;
    const max = state.posMax;
    if (src[start] !== '$') return false;
    const isDisplay = src[start + 1] === '$';
    const delim = isDisplay ? '$$' : '$';
    let pos = start + delim.length;
    if (isDisplay && src[pos] === '$') return false; // 排除 $$$
    if (!isDisplay && (src[pos] === ' ' || src[pos] === '\t')) return false;
    let content = '';
    while (pos < max) {
        if (src[pos] === '\\' && pos + 1 < max) {
            content += src.slice(pos, pos + 2);
            pos += 2;
            continue;
        }
        if (src.startsWith(delim, pos)) {
            // 单 $：内容不能为空、结束 $ 前不能是空白；$$：内容不能为空
            if (content.trim() === '' || (!isDisplay && /[\s]$/.test(content))) return false;
            if (!silent) {
                const token = state.push('math_inline', 'math', 0);
                token.content = content.trim();
                token.markup = delim;
            }
            state.pos = pos + delim.length;
            return true;
        }
        content += src[pos];
        pos++;
    }
    return false;
}

// 块级公式：$$ 独占行开始，到下一个含 $$ 的行为止（支持 $$...$$ 同行闭合）
function mathBlockRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
    const src = state.src;
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (pos + 2 > max || src.slice(pos, pos + 2) !== '$$') return false;
    let content = src.slice(pos + 2, max).trim();
    let found = false;
    if (content.endsWith('$$')) {
        content = content.slice(0, -2).trim();
        found = true;
    }
    let last = startLine;
    while (!found) {
        last++;
        if (last >= endLine) return false;
        const ls = state.bMarks[last] + state.tShift[last];
        const le = state.eMarks[last];
        const line = src.slice(ls, le);
        const idx = line.indexOf('$$');
        if (idx === -1) { content += '\n' + line; continue; }
        content += '\n' + line.slice(0, idx).trimEnd();
        found = true;
    }
    if (silent) return true;
    const token = state.push('math_block', 'math', 0);
    token.content = content.trim();
    token.markup = '$$';
    token.map = [startLine, last + 1];
    state.line = last + 1;
    return true;
}

md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
md.renderer.rules.math_block = (tokens, idx) => renderMath(tokens[idx].content, true) + '\n';
md.inline.ruler.before('escape', 'math_inline', mathInlineRule);
md.block.ruler.before('fence', 'math_block', mathBlockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

// ---------------- Material tabbed（`=== "标题"`）兼容 ----------------
// 自行实现块级规则，避免引入不确定的第三方 tab 插件。
function deindent(lines: string[]): string[] {
    let min = Infinity;
    for (const l of lines) {
        if (l.trim() === '') continue;
        const ind = l.length - l.trimStart().length;
        if (ind < min) min = ind;
    }
    if (!isFinite(min) || min === 0) return lines;
    return lines.map((l) => (l.startsWith(' '.repeat(min)) ? l.slice(min) : l));
}

// 模块级计数器：applyBlocks 会因 details 折叠块递归调用，若用局部计数器，
// 不同层级的 tab 组会生成重复的 name/id —— radio 互斥跨组、label for 定位到
// 文档中第一个同 id 元素，导致选中标签与显示内容错位。
let tabGroupId = 0;

function renderTabs(tabs: { title: string; body: string }[]): string {
    const name = `tabset-${++tabGroupId}`;
    // input 与对应 label 必须成对紧邻，否则 CSS 的 `:checked + label`
    // 相邻兄弟选择器会命中到错误的 label（导致多个标签同时高亮）。
    const items = tabs.map((t, k) =>
        `<input type="radio" class="wiki-tabbed-input" name="${name}" id="${name}-${k}"${k === 0 ? ' checked' : ''}>`
        + `<label class="wiki-tabbed-label" for="${name}-${k}">${md.renderInline(t.title)}</label>`,
    ).join('');
    const blocks = tabs.map((t) => `<div class="wiki-tabbed-block">${t.body}</div>`).join('');
    return `<div class="wiki-tabbed-set">${items}<div class="wiki-tabbed-content">${blocks}</div></div>`;
}

// ---------------- Material 片段包含 `--8<-- "path"` ----------------
// 兼容 mkdocs-material（pymdownx.snippets）语法：
//   --8<-- "docs/dp/code/x.cpp"            整文件
//   --8<-- "docs/dp/code/x.cpp:10-20"      行范围（1-based，含端点）
//   --8<-- "docs/dp/code/x.cpp:core"       区段（取 [start:core]~[end:core] 标记间的行）
// 路径含 docs/ 前缀时相对仓库 docs 目录解析。
function resolveSnippetContent(raw: string): string | null {
    const idx = raw.indexOf(':');
    const p = idx >= 0 ? raw.slice(0, idx) : raw;
    const selector = idx >= 0 ? raw.slice(idx + 1) : '';
    let rel = p;
    if (rel.startsWith('docs/')) rel = rel.slice('docs/'.length);
    const file = docsPath(rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    let lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    if (selector) {
        if (/^\d+-\d+$/.test(selector)) {
            const [a, b] = selector.split('-').map((n) => parseInt(n, 10));
            lines = lines.slice(a - 1, b);
        } else {
            let s = -1;
            let e = -1;
            for (let k = 0; k < lines.length; k++) {
                if (s < 0 && lines[k].includes(`[start:${selector}]`)) s = k;
                else if (s >= 0 && e < 0 && lines[k].includes(`[end:${selector}]`)) { e = k; break; }
            }
            if (s >= 0 && e >= 0) lines = lines.slice(s + 1, e);
            // 找不到标记则回退为整文件
        }
    }
    return lines.join('\n');
}

function applyBlocks(src: string): string {
    const lines = src.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        // 整块消费围栏代码块：mermaid 直接转成 <pre class="mermaid">，
        // 避免其处于注入的 HTML 块之后时不被 markdown-it 解析；
        // 其余代码块原样交回 markdown-it 处理。
        const fence = /^(\s*)(```|~~~)(.*)$/.exec(line);
        if (fence) {
            const marker = fence[2];
            const info = fence[3].trim();
            const buf = [line];
            i++;
            const closeRe = new RegExp('^\\s*' + marker.replace(/[`~]/g, '\\$&') + '\\s*$');
            while (i < lines.length && !closeRe.test(lines[i])) {
                buf.push(lines[i]); i++;
            }
            if (i < lines.length) { buf.push(lines[i]); i++; }
            if (info === 'mermaid') {
                const code = buf.slice(1, buf.length - 1).join('\n');
                out.push(`<pre class="mermaid">${md.utils.escapeHtml(code)}</pre>`);
            } else {
                // 围栏内的片段包含按原样（作为代码内容）内联展开
                const expanded = buf.map((l) => {
                    const sm = /^\s*--8<--\s+"([^"]+)"\s*$/.exec(l);
                    if (!sm) return l;
                    const c = resolveSnippetContent(sm[1]);
                    return c == null ? l : c;
                });
                out.push(expanded.join('\n'));
            }
            continue;
        }
        // 独立行片段包含：作为 Markdown 展开（递归处理内部嵌套片段/语法）
        const snip = /^\s*--8<--\s+"([^"]+)"\s*$/.exec(line);
        if (snip) {
            const content = resolveSnippetContent(snip[1]);
            if (content != null) {
                out.push('');
                out.push(applyBlocks(content));
                out.push('');
            } else {
                out.push(line);
            }
            i++;
            continue;
        }
        // Material 折叠提示块：??? / ???+ type "标题"（标题支持行内 markdown，可含超链接；+ 表示默认展开）
        const det = /^(\s*)\?{3}(\+?)\s+([\w-]+)(?:\s+"([^"]*)"|\s+(.+?))?\s*$/.exec(line);
        if (det) {
            const indent = det[1].length;
            const open = det[2] === '+' ? ' open' : '';
            const type = det[3];
            const title = det[4] ?? det[5] ?? type.charAt(0).toUpperCase() + type.slice(1);
            i++;
            const content: string[] = [];
            while (i < lines.length) {
                const l = lines[i];
                if (l.trim() === '') { content.push(''); i++; continue; }
                const ind = l.length - l.trimStart().length;
                if (ind <= indent) break;
                content.push(l); i++;
            }
            // 递归处理内部（支持嵌套折叠块 / tab / 代码围栏），再包进 <details>
            const inner = applyBlocks(deindent(content).join('\n'));
            out.push(`<details class="admonition ${type}"${open}>`);
            out.push(`<summary>${md.renderInline(title)}</summary>`);
            out.push('<div class="admonition-content">');
            out.push('');
            out.push(inner);
            out.push('');
            out.push('</div>');
            out.push('</details>');
            out.push('');
            continue;
        }
        const m = /^(\s*)(=+)\s+"([^"]*)"\s*$/.exec(line);
        if (!m) { out.push(line); i++; continue; }
        const indent = m[1].length;
        const tabs: { title: string; body: string }[] = [];
        while (i < lines.length) {
            const mm = /^(\s*)(=+)\s+"([^"]*)"\s*$/.exec(lines[i]);
            if (!mm) break;
            const title = mm[3];
            i++;
            const content: string[] = [];
            while (i < lines.length) {
                const l = lines[i];
                if (l.trim() === '') { content.push(''); i++; continue; }
                const ind = l.length - l.trimStart().length;
                if (ind <= indent) break;
                content.push(l); i++;
            }
            // 先经 applyBlocks：使 tab 内的代码片段(--8<--)、嵌套 tab、mermaid 等也能正常展开
            tabs.push({ title, body: md.render(applyBlocks(deindent(content).join('\n'))) });
        }
        out.push(renderTabs(tabs));
    }
    return out.join('\n');
}

// ---------------- 链接 / 图片改写 ----------------
function stripDoc(p: string): string {
    // 先分离 #fragment / ?query，否则 `op.md#锚点` 形式剥不掉 .md 后缀
    const hashIdx = p.indexOf('#');
    const frag = hashIdx >= 0 ? p.slice(hashIdx) : '';
    if (hashIdx >= 0) p = p.slice(0, hashIdx);
    p = p.replace(/\.md$/, '').replace(/\.html?$/, '');
    p = p.replace(/(^|\/)index$/, '$1');
    if (p === '' || p === '/') return '/oiwiki' + frag;
    return '/oiwiki/' + p.replace(/^\//, '') + frag;
}

function isDocLink(raw: string): boolean {
    if (/\.md(#.*)?$/.test(raw)) return true;
    if (/\.html?(#.*)?$/.test(raw)) return true;
    // 没有明显的文件扩展名（如 intro/about）视为文档链接
    if (!/[\w-]+\.[a-z0-9]{1,10}([#?]|$)/i.test(raw)) return true;
    return false;
}

function resolveLink(raw: string, curDir: string): string {
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('mailto:') || raw.startsWith('data:') || raw.startsWith('#')) return raw;
    if (raw.startsWith('/oiwiki')) return raw; // 已经改写过
    let p = raw.startsWith('/') ? raw.slice(1) : path.posix.join(curDir, raw);
    if (!isDocLink(raw)) return raw;
    return stripDoc(p);
}

function resolveImage(raw: string, curDir: string): string {
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('mailto:') || raw.startsWith('data:')) return raw;
    if (raw.startsWith('/oiwiki-assets')) return raw; // 已经改写过
    const p = raw.startsWith('/') ? raw.slice(1) : path.posix.join(curDir, raw);
    return '/oiwiki-assets/' + p.replace(/^\//, '');
}

function rewriteUrls(html: string, curDir: string): string {
    const fix = (attr: string, val: string) => (attr === 'src' ? resolveImage(val, curDir) : resolveLink(val, curDir));
    return html
        .replace(/(href|src)\s*=\s*"([^"]*)"/g, (_, attr, val) => `${attr}="${fix(attr, val)}"`)
        .replace(/(href|src)\s*=\s*'([^']*)'/g, (_, attr, val) => `${attr}='${fix(attr, val)}'`);
}

function extractTitle(src: string): string {
    // 跳过围栏代码块内的内容（如 Python 的 "# 注释"），避免误判为一级标题
    const lines = src.split(/\r?\n/);
    let inFence = false;
    let firstHeading: string | null = null;
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (m) {
            if (m[1].length === 1) return m[2].replace(/[*_`#]/g, '').trim();
            if (!firstHeading) firstHeading = m[2].replace(/[*_`#]/g, '').trim();
        }
    }
    return firstHeading ?? 'OI Wiki';
}

// ---------------- 页首元数据解析（对应原站 python-markdown meta 扩展） ----------------
// meta 行：ASCII 键 + ':' + （空格 + 值）或空值。与原站行为一致：
// `Code::Blocks 是…`（冒号后紧跟非空格）、`Q：…`（全角冒号）都不算 meta，保留为正文。
const META_LINE = /^[A-Za-z][\w-]*:(?:[ \t][^\r\n]*)?$/;

function normalizeAuthors(a: unknown): string[] {
    if (Array.isArray(a)) return a.map((x) => String(x).trim()).filter(Boolean);
    return String(a).split(/[，,]/).map((s) => s.trim()).filter(Boolean);
}

// 头部元数据不删除而是重构展示形式：
// author -> 标题下署名行；title -> 页面标题；disqus/pagetime 等空值键是原站主题的功能开关，本就不渲染内容。
function parseWikiMeta(src: string): { authors: string[] | null; title: string | null; body: string } {
    let body = src;
    let authors: string[] | null = null;
    let title: string | null = null;

    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
    if (fm) {
        try {
            const meta = (yaml.load(fm[1]) as any) || {};
            const a = meta.author ?? meta.authors;
            if (a) authors = normalizeAuthors(a);
            if (meta.title) title = String(meta.title).trim() || null;
        } catch { /* 非标准 frontmatter 走行级回退 */ }
        // YAML 解析失败或字段缺失时，仍从 frontmatter 原文提取，避免署名丢失
        if (!authors) {
            const am = /^authors?\s*[：:]\s*(.+)\s*$/im.exec(fm[1]);
            if (am) authors = normalizeAuthors(am[1]);
        }
        if (!title) {
            const tm = /^title\s*[：:]\s*(.+)\s*$/im.exec(fm[1]);
            if (tm) title = tm[1].replace(/^["']|["']$/g, '').trim() || null;
        }
        body = src.slice(fm[0].length);
    } else {
        const lines = src.split(/\r?\n/);
        let k = 0;
        while (k < lines.length && META_LINE.test(lines[k])) k++;
        if (k > 0) {
            for (const line of lines.slice(0, k)) {
                const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)!;
                const key = m[1].toLowerCase();
                const val = m[2].trim();
                // autor 是原仓库个别文件（math/binary-exponentiation.md）的拼写错误，一并识别
                if ((key === 'author' || key === 'authors' || key === 'autor') && val) authors = normalizeAuthors(val);
                else if (key === 'title' && val) title = val;
            }
            body = lines.slice(k).join('\n');
        } else {
            body = src.replace(/^authors?\s*[：:]\s*(.+)\r?$/gim, (_w, val) => {
                if (!authors) authors = normalizeAuthors(val);
                return '';
            });
        }
    }
    return { authors, title, body };
}

function renderAuthorsByline(authors: string[]): string {
    const list = authors.map((n) => md.utils.escapeHtml(n)).join('、');
    return `<div class="wiki-authors">作者：${list}</div>`;
}

// ---------------- 渲染入口（带 mtime 缓存） ----------------
const contentCache = new Map<string, { mtime: number; html: string; title: string }>();

export function renderWiki(rel: string, curDir: string): { html: string; title: string } {
    const file = docsPath(rel);
    const mtime = fs.statSync(file).mtimeMs;
    const cached = contentCache.get(rel);
    if (cached && cached.mtime === mtime) return { html: cached.html, title: cached.title };
    const src = fs.readFileSync(file, 'utf-8');
    const { authors, title: metaTitle, body } = parseWikiMeta(src);
    let html = applyBlocks(body);
    html = md.render(html);
    // markdown-it-katex 把块级公式渲染成 <span class="katex-display">（display:block），
    // 但被 markdown-it 当成行内内容包进 <p>，浏览器会拆分 <p> 导致公式错位；
    // 这里把独占一行的块公式从 <p> 中解包出来。
    html = html.replace(/<p>\s*(<span class="katex-display">[\s\S]*?<\/span>)\s*<\/p>/g, '$1');
    html = rewriteUrls(html, curDir);
    // 剔除指向 img.shields.io 的社交徽章（如首页的 Watch/Stars），
    // 这些外链在国内网络打不开且只是装饰；但保留 license/CC 等许可徽章，
    // 它们承载原作的许可信息，出于版权合规不应移除。
    html = html.replace(/<img\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']*img\.shields\.io[^"']*["'][^>]*>/gi, (tag) => (
        /license|badge\/cc|\/cc[-/]|by-sa|creativecommons/i.test(tag) ? tag : ''
    ));
    // typographer 会把 !!! 提示块标题两侧作为定界符的 " 也转成中文弯引号“”，
    // 按 Material 语义引号只是定界符、不应显示；这里去掉标题段落首尾的弯引号。
    html = html.replace(/(<p class="admonition-title">)“([\s\S]*?)”(<\/p>)/g, '$1$2$3');
    if (authors && authors.length) {
        const byline = renderAuthorsByline(authors);
        const idx = html.indexOf('</h1>');
        if (idx >= 0) html = html.slice(0, idx + 5) + byline + html.slice(idx + 5);
        else html = byline + html;
    }
    // 页面标题优先用元数据 title（与原站标签页标题一致），否则取首个标题
    const title = (metaTitle && metaTitle.trim()) || extractTitle(body);
    const result = { html, title };
    contentCache.set(rel, { mtime, ...result });
    return result;
}
