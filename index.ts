import { Context, Handler, Schema, mime, PRIV } from 'hydrooj';

// 校验当前用户已登录，未登录则报错由框架引导登录
const requireLogin = PRIV.PRIV_USER_PROFILE;
import fs from 'fs';
import path from 'path';
import { setConfig, updateCache, isReady, docsPath, safeJoinDocs } from './lib/cache';
import { renderWiki } from './lib/markdown';
import { renderSidebar, normalizeKey } from './lib/nav';
import { searchWiki, highlightSearch } from './lib/search';

export const Config = Schema.object({
    repo: Schema.string().default('https://github.com/OI-wiki/OI-wiki.git').description('主源码仓库地址'),
    mirrors: Schema.string().default('https://gitcode.com/GitHub_Trending/oi/OI-wiki.git').description('备用源列表（逗号或空格分隔，按顺序探测，留空则只用主源），可填任意镜像仓库'),
    branch: Schema.string().default('master').description('源码分支名'),
    proxy: Schema.string().default('').description('Git 加速前缀（可选，如 https://gh-proxy.com/ ），仅作用于 GitHub 类地址'),
    updateOnStart: Schema.boolean().default(true).description('启动时后台同步最新源码（不阻塞启动）'),
    scheduledUpdate: Schema.boolean().default(true).description('按固定周期后台更新源码（不阻塞运行）'),
    updateIntervalHours: Schema.number().default(24).description('定时更新周期（小时），小于 0.01 时禁用定时更新'),
});

class OIWikiSearchHandler extends Handler {
    async get() {
        const q = String(this.request.query.q || '').trim();
        const results = q ? searchWiki(q, { limit: 50 }) : [];

        if (String(this.request.query.format || '').toLowerCase() === 'json') {
            this.response.type = 'application/json';
            this.response.body = {
                query: q,
                count: results.length,
                results: results.map(({ rel, title, url, pathLabel, snippet }) => ({
                    rel,
                    title,
                    url,
                    pathLabel,
                    snippet: snippet.text,
                })),
            };
            return;
        }

        const sidebarHtml = renderSidebar('index');
        const body = {
            title: q ? `搜索“${q}”` : '搜索 OI Wiki',
            sidebarHtml,
            searchQuery: q,
            searchResults: results.map((r) => ({
                title: highlightSearch(r.title, q),
                pathLabel: highlightSearch(r.pathLabel, q),
                rel: r.rel,
                url: r.url,
                snippet: r.snippet.text,
            })),
            loading: false,
            contentHtml: '',
        };
        this.response.template = 'oiwiki_page.html';
        this.response.body = body;
    }
}

class OIWikiPageHandler extends Handler {
    async get() {
        let sub = this.request.path.slice('/oiwiki'.length);
        if (sub.startsWith('/')) sub = sub.slice(1);
        try { sub = decodeURIComponent(sub); } catch { /* keep raw */ }

        // 解析为缓存目录 docs/ 下的 .md 文件
        let rel = sub;
        if (rel === '') rel = 'index.md';
        else if (rel.endsWith('/')) rel = rel + 'index.md';
        else if (rel.endsWith('.html')) rel = rel.slice(0, -5) + '.md';
        else if (!/\.[a-z0-9]+$/i.test(rel)) rel = rel + '.md';

        // 源码尚未同步完成：后台继续拉取，返回提示页并自动刷新
        if (!isReady()) {
            updateCache();
            this.response.status = 503;
            this.response.template = 'oiwiki_page.html';
            this.response.body = {
                title: 'OI Wiki 同步中',
                sidebarHtml: '',
                contentHtml: '<div class="wiki-loading"><p>OI Wiki 源码正在后台同步，请稍候…</p>'
                    + '<p>首次同步需要下载文档仓库，可能需要几分钟；页面会自动刷新。</p>'
                    + '<p>若长时间停留在本页，请查看 Hydro 日志中的 [oiwiki] 报错（插件会先探测主源与 mirrors 备用源的连通性再同步），必要时在插件配置中调整源列表或加速前缀。</p></div>',
                loading: true,
            };
            return;
        }

        const sidebarHtml = renderSidebar(normalizeKey(rel));
        const file = docsPath(rel);
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
            const curDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
            const { html, title } = renderWiki(rel, curDir);
            this.response.template = 'oiwiki_page.html';
            this.response.body = { title, sidebarHtml, contentHtml: html, hasMermaid: html.includes('class="mermaid"') };
            return;
        }

        this.response.status = 404;
        this.response.template = 'oiwiki_page.html';
        this.response.body = {
            title: '页面未找到',
            sidebarHtml,
            contentHtml: '<p>找不到该 OI Wiki 页面。</p>',
        };
    }
}

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    setConfig(config.repo, config.branch, config.proxy, config.mirrors);
    console.log(`[oiwiki] 源码缓存目录：${path.resolve(__dirname, 'cache', 'oi-wiki')}`);

    ctx.Route('oiwiki', '/oiwiki', OIWikiPageHandler, requireLogin);
    ctx.Route('oiwiki_search', '/oiwiki/search', OIWikiSearchHandler, requireLogin);
    ctx.Route('oiwiki_page', /^\/oiwiki(?:\/.*)?$/ as any, OIWikiPageHandler, requireLogin);

    // 静态资源（图片等）服务，根目录对应缓存的 docs/
    // 注意：捕获路由在 Koa 早期拦截，此时 c.user 尚未被会话中间件填充，
    // 无法可靠判断登录态；且图片仅是已登录页面（/oiwiki/* 路由已强制登录）
    // 的子资源，无需在此重复拦截，否则会让所有用户（含已登录）的图片 403。
    ctx.server.addCaptureRoute('/oiwiki-assets/', async (c: any) => {
        let sub = decodeURIComponent(c.path.slice('/oiwiki-assets/'.length));
        if (sub === '' || sub.endsWith('/')) sub += 'index.html';
        const target = safeJoinDocs(sub);
        if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
            c.status = 404;
            c.body = 'Not Found';
            return;
        }
        const raw = fs.readFileSync(target);
        const type = mime(target);
        c.type = type.includes('css') ? 'text/css; charset=utf-8' : type;
        c.body = raw;
    });

    // 本地托管 KaTeX 样式：插件已依赖 katex 包，直接读取其 dist 下的 CSS，
    // 避免模板里写死公网 jsdelivr CDN（国内网络打不开，会导致公式无样式）。
    const katexCssPath = (() => {
        const candidates = [
            path.join(__dirname, 'node_modules', 'katex', 'dist', 'katex.min.css'),
            path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.min.css'),
            path.join(__dirname, '..', '..', 'node_modules', 'katex', 'dist', 'katex.min.css'),
        ];
        return candidates.find((p) => fs.existsSync(p)) || null;
    })();
    if (katexCssPath) {
        ctx.server.addCaptureRoute('/oiwiki-assets/vendor/', async (c: any) => {
            const file = c.path.slice('/oiwiki-assets/vendor/'.length);
            if (file === 'katex.min.css') {
                c.type = 'text/css; charset=utf-8';
                c.body = fs.readFileSync(katexCssPath);
            } else {
                c.status = 404;
                c.body = 'Not Found';
            }
        });
    } else {
        console.warn('[oiwiki] 未找到 katex.min.css，公式样式可能缺失（请确认 katex 依赖已安装）');
    }

    ctx.i18n.load('zh', { 'OI Wiki': 'OI Wiki' });
    ctx.i18n.load('en', { 'OI Wiki': 'OI Wiki' });

    // 管理脚本：手动触发源码同步
    ctx.addScript('oiwiki_update', 'OI Wiki：手动更新源码缓存', Schema.any(), async () => {
        await updateCache(true);
        return true;
    });

    // 首次或配置要求时后台同步，不阻塞 Hydro 启动
    if (config.updateOnStart || !isReady()) updateCache();

    // 定时后台更新；ctx.interval 会在插件卸载时自动清理
    const intervalHours = config.updateIntervalHours;
    if (config.scheduledUpdate && Number.isFinite(intervalHours) && intervalHours >= 0.01) {
        const intervalMs = Math.max(1, Math.round(intervalHours * 60 * 60 * 1000));
        console.log(`[oiwiki] 已启用定时更新，每 ${intervalHours} 小时同步一次源码`);
        ctx.interval(async () => {
            // updateCache 内部已自行判断：存在 .git 则 pull，否则 clone，
            // 且失败后有 10 分钟退避，直接调用即可（不要再引用未导入的 cacheDir）。
            await updateCache();
        }, intervalMs);
    }
}
