import fs from 'fs';
import path from 'path';
import { docsPath, isReady } from './cache';
import { normalizeKey } from './nav';

export interface SearchDoc {
    rel: string;
    title: string;
    url: string;
    pathLabel: string;
    body: string;
}

export interface SearchSnippet {
    text: string;
    terms: string[];
}

export interface SearchHit {
    rel: string;
    title: string;
    url: string;
    pathLabel: string;
    snippet: SearchSnippet;
    score: number;
}

export interface SearchOptions {
    limit?: number;
    snippetLength?: number;
}

let searchCache: { docsMtime: string; docs: SearchDoc[] } | null = null;

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function decodeUnicode(text: string): string {
    // OI Wiki 中部分 Markdown 使用 \uXXXX 表示特殊符号；转成 Unicode 后再搜索。
    return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function stripForSearch(src: string): string {
    return src
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
        // 头部 meta 块（key: value 行）与正文无关，不进索引
        .replace(/^([A-Za-z][\w-]*:(?:[ \t][^\r\n]*)?\r?\n)+/, ' ')
        .replace(/^authors?\s*[：:]\s*.+$/gim, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');
}

function fileTitle(rel: string, src: string): string {
    // 跳过代码围栏里的 # 注释，避免把程序注释误判成标题。
    const lines = src.split(/\r?\n/);
    let inFence = false;
    let firstHeading: string | null = null;
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
        if (inFence) continue;
        const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        if (m[1].length === 1) return m[2].replace(/[*_`#]/g, '').trim();
        if (!firstHeading) firstHeading = m[2].replace(/[*_`#]/g, '').trim();
    }
    if (firstHeading) return firstHeading;

    // MkDocs 常见写法：首行 `title: ...` 但不是完整 YAML frontmatter。
    const lineTitle = /^\s*title\s*[：:]\s*(.+)$/im.exec(src);
    if (lineTitle) return lineTitle[1].replace(/^["']|["']$/g, '').trim();

    return rel.split('/').slice(-1)[0]
        .replace(/\.md$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim() || 'OI Wiki';
}

function pathLabel(rel: string): string {
    const parts = rel.replace(/\/?index\.md$/i, '').replace(/\.md$/i, '').split('/').filter(Boolean);
    if (!parts.length) return 'OI Wiki';
    if (parts.length === 1) return decodeUnicode(parts[0].replace(/[-_]+/g, ' '));
    return decodeUnicode(parts[parts.length - 2].replace(/[-_]+/g, ' '));
}

function docUrl(rel: string): string {
    const k = normalizeKey(rel);
    return k === 'index' ? '/oiwiki' : '/oiwiki/' + k;
}

function walkDocs(dir: string): string[] {
    const res: string[] = [];
    let items: fs.Dirent[];
    try {
        items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return res;
    }
    for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) res.push(...walkDocs(full));
        else if (item.isFile() && /\.md$/i.test(item.name)) res.push(full);
    }
    return res;
}

export function getAllSearchDocs(): SearchDoc[] {
    const root = path.dirname(docsPath('index.md'));
    const rootStat = fs.existsSync(root) ? fs.statSync(root) : null;
    const rootFingerprint = rootStat ? `${rootStat.mtimeMs}:${rootStat.size}` : 'missing';
    if (searchCache && searchCache.docsMtime === rootFingerprint) return searchCache.docs;

    const docs: SearchDoc[] = [];
    if (!isReady() || !rootStat) {
        searchCache = { docsMtime: rootFingerprint, docs };
        return docs;
    }

    for (const file of walkDocs(root)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        let src = '';
        try {
            src = fs.readFileSync(file, 'utf-8');
        } catch {
            continue;
        }
        docs.push({
            rel,
            title: fileTitle(rel, src),
            url: docUrl(rel),
            pathLabel: pathLabel(rel),
            body: stripForSearch(src),
        });
    }
    searchCache = { docsMtime: rootFingerprint, docs };
    return docs;
}

function normalizeQuery(q: string): string {
    return q.toLowerCase().trim().replace(/\s+/g, ' ');
}

function splitTerms(query: string): string[] {
    const q = normalizeQuery(query);
    if (!q) return [];
    const terms: string[] = [];
    const re = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu;
    for (const term of q.matchAll(re)) terms.push(term[0]);
    return terms.length ? terms : [q];
}

function escapeRegex(s: string): string {
    return s.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function tokenize(text: string, terms: string[]): string[] {
    const lowered = text.toLowerCase();
    const re = new RegExp(terms.map(escapeRegex).join('|'), 'gu');
    const res: string[] = [];
    for (const m of lowered.matchAll(re)) {
        if (m.index !== undefined) res.push(`${m.index}:${m[0].length}`);
    }
    return res.sort((a, b) => {
        const [sa, la] = a.split(':').map(Number);
        const [sb, lb] = b.split(':').map(Number);
        return sa - sb || lb - la;
    });
}

function getSnippet(text: string, terms: string[], length: number): string {
    const tokens = tokenize(text, terms);
    if (!tokens.length) return text.slice(0, length).trim();
    const first = tokens[0];
    const start = Math.max(0, parseInt(first, 10) - Math.floor(length / 2));
    const end = Math.min(text.length, start + length);
    let snip = text.slice(start, end).trim();
    if (start > 0) snip = '…' + snip;
    if (end < text.length) snip = snip + '…';
    return snip;
}

function scoreDoc(doc: SearchDoc, terms: string[]): number {
    if (!terms.length) return 0;
    const title = doc.title.toLowerCase();
    const rel = doc.rel.toLowerCase();
    const body = doc.body.toLowerCase();
    const titleTokens = tokenize(title, terms);
    const relTokens = tokenize(rel, terms);
    const bodyTokens = tokenize(body, terms);
    if (!titleTokens.length && !relTokens.length && !bodyTokens.length) return 0;

    let score = 0;
    for (const term of terms) {
        const titleTerm = title.includes(term);
        const relTerm = rel.includes(term);
        const bodyTerm = body.includes(term);
        if (!titleTerm && !relTerm && !bodyTerm) return 0;
        if (titleTerm) score += 60 + (title.startsWith(term) ? 20 : 0);
        if (relTerm) score += 25;
        if (bodyTerm) score += Math.min(20, 2 + body.split(term).length - 1);
    }
    return score;
}

function termHighlighter(terms: string[]): (s: string) => string {
    const escaped = terms.map(escapeRegex).join('|');
    const re = new RegExp(`(${escaped})`, 'giu');
    return (s: string) => escapeHtml(s).replace(re, '<mark>$1</mark>');
}

export function searchWiki(query: string, options: SearchOptions = {}): SearchHit[] {
    const terms = splitTerms(query);
    if (!terms.length) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
    const snippetLength = Math.max(60, Math.min(options.snippetLength ?? 180, 500));

    const hits: SearchHit[] = [];
    for (const doc of getAllSearchDocs()) {
        const score = scoreDoc(doc, terms);
        if (!score) continue;
        hits.push({
            rel: doc.rel,
            title: doc.title,
            url: doc.url,
            pathLabel: doc.pathLabel,
            snippet: { text: getSnippet(doc.body, terms, snippetLength), terms },
            score,
        });
    }
    return hits
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
        .slice(0, limit)
        .map((h) => ({ ...h, snippet: { ...h.snippet, text: termHighlighter(terms)(h.snippet.text) } }));
}

export function highlightSearch(text: string, query: string): string {
    return termHighlighter(splitTerms(query))(text);
}
