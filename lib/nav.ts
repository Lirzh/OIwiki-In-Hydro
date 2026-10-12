import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { cacheDir } from './cache';

export interface NavNode {
    title: string;
    url?: string;
    key?: string;
    children: NavNode[];
}

let navCache: { mtime: number; tree: NavNode[] } | null = null;

// 把文档目标（如 intro/index.md）归一成用于比较的 key（如 intro/index / index）
export function normalizeKey(target: string): string {
    let p = target.replace(/\.md$/, '').replace(/\.html?$/, '');
    p = p.replace(/(^|\/)index$/, '$1');
    if (p === '' || p === '/') return 'index';
    return p.replace(/^\//, '');
}

function navTargetToUrl(target: string): string {
    const k = normalizeKey(target);
    return k === 'index' ? '/oiwiki' : '/oiwiki/' + k;
}

function parseNav(nav: unknown): NavNode[] {
    if (!nav || typeof nav !== 'object') return [];
    // 列表式：nav 为数组，每项是一组 { 标题: 目标 }
    if (Array.isArray(nav)) {
        const res: NavNode[] = [];
        for (const item of nav as any[]) {
            if (typeof item === 'string') continue;
            if (item && typeof item === 'object') {
                for (const [title, val] of Object.entries(item)) {
                    if (typeof val === 'string') res.push({ title, url: navTargetToUrl(val), key: normalizeKey(val), children: [] });
                    else res.push({ title, children: parseNav(val) });
                }
            }
        }
        return res;
    }
    // 字典式：nav 或某段落为 { 标题: 目标 | 子段 }, 递归解析
    const res: NavNode[] = [];
    for (const [title, val] of Object.entries(nav as any)) {
        if (typeof val === 'string') res.push({ title, url: navTargetToUrl(val), key: normalizeKey(val), children: [] });
        else res.push({ title, children: parseNav(val) });
    }
    return res;
}

// MkDocs 的 mkdocs.yml 会用到 Python 专有 YAML 标签（!!python/name:、!!python/object/... 等），
// js-yaml 无法解析。这些标签只影响 mkdocs 扩展配置，与导航结构无关，中和成 null 即可。
function neutralizePythonTags(text: string): string {
    return text
        .replace(/!!python\/[^\s]+/g, 'null')
        .replace(/!<tag:yaml\.org,2002:python[^>]*>/g, 'null');
}

export function getNavTree(): NavNode[] {
    const file = path.join(cacheDir, 'mkdocs.yml');
    if (!fs.existsSync(file)) return [];
    const mtime = fs.statSync(file).mtimeMs;
    if (navCache && navCache.mtime === mtime) return navCache.tree;
    let tree: NavNode[] = [];
    try {
        const raw = fs.readFileSync(file, 'utf-8');
        const doc = yaml.load(neutralizePythonTags(raw)) as any;
        tree = parseNav(doc?.nav ?? []);
    } catch (e) {
        console.error('[oiwiki] 解析 mkdocs.yml 的导航失败：', (e as Error).message);
    }
    navCache = { mtime, tree };
    return tree;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderNodes(nodes: NavNode[], currentPath: string): string {
    let out = '';
    for (const n of nodes) {
        if (n.children.length) {
            const childHtml = renderNodes(n.children, currentPath);
            const open = childHtml.includes('wiki-nav__link--active');
            out += `<li class="wiki-nav__item${open ? ' wiki-nav__item--open' : ''}">`
                + `<div class="wiki-nav__group">${escapeHtml(n.title)}</div>`
                + `<ul class="wiki-nav__sublist">${childHtml}</ul></li>`;
        } else {
            const active = n.key === currentPath;
            out += `<li class="wiki-nav__item"><a class="wiki-nav__link${active ? ' wiki-nav__link--active' : ''}" href="${n.url}">${escapeHtml(n.title)}</a></li>`;
        }
    }
    return out;
}

export function renderSidebar(currentKey: string): string {
    const tree = getNavTree();
    return `<ul class="wiki-nav__list">${renderNodes(tree, currentKey)}</ul>`;
}
