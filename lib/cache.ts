import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

// 缓存目录默认位于插件根目录下的 cache/oi-wiki
export let cacheDir = path.resolve(__dirname, 'cache', 'oi-wiki');
export let repoUrl = 'https://github.com/OI-wiki/OI-wiki.git';
export let branchName = 'master';
// 加速前缀（如 https://gh-proxy.com/ ），最终克隆地址为 proxy + repoUrl
export let proxy = '';
// 备用源列表（主源不可达时按顺序探测），来自插件配置 mirrors
let mirrorUrls: string[] = [];

// 上一次同步成功的完整源地址；同步时排在候选首位，配合连通性探测可直接沿用可用镜像
let activeUrl: string | null = null;

export function setConfig(repo: string, branch: string, proxyPrefix?: string, mirrors?: string) {
    repoUrl = repo;
    branchName = branch;
    proxy = proxyPrefix || '';
    mirrorUrls = (mirrors || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    activeUrl = null;
}

export function setCacheDir(dir: string) {
    cacheDir = dir;
}

// 候选源地址：配置的 repo 为主，后接可配置的备用源列表（去重），按顺序探测
function candidates(): string[] {
    return [...new Set([repoUrl, ...mirrorUrls].filter(Boolean))];
}

// 加速前缀仅对 GitHub 类地址有意义，国内镜像不再叠加
function withProxy(url: string): string {
    return proxy && url.includes('github.com') ? proxy.replace(/\/?$/, '/') + url : url;
}

function orderedTargets(): string[] {
    const all = candidates().map(withProxy);
    if (activeUrl && all.includes(activeUrl)) return [activeUrl, ...all.filter((u) => u !== activeUrl)];
    return all;
}

// 源码是否已就绪（以 mkdocs.yml 为标志）
export function isReady(): boolean {
    return fs.existsSync(path.join(cacheDir, 'mkdocs.yml'));
}

// git 命令统一走 execFile + 参数数组：仓库地址/分支来自插件配置，
// 拼进 shell 字符串会有 $(...) 等注入面，数组传参则完全按字面量处理。
function git(args: string[], cwd?: string, timeoutMs = 10 * 60 * 1000): Promise<string> {
    // 规避 Git「dubious ownership」：缓存仓库可能由其他用户（如 root）创建，
    // 而 Hydro 进程以另一用户运行，git 会拒绝操作。通过环境变量让本次调用信任所有目录，
    // 免改全局 git 配置、也无需手动执行 git config --global --add safe.directory。
    const env = {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
    };
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${err.message}\n${stderr || stdout}`));
            else resolve(stdout);
        });
    });
}

// 连通性探测：git ls-remote 只查询分支引用，不传输对象，秒级返回；
// 用它先筛掉不可达的源，避免在 clone/fetch 上白等长超时。
async function probe(url: string): Promise<boolean> {
    try {
        const out = await git(['ls-remote', '--heads', url, branchName], undefined, 20 * 1000);
        return out.trim().length > 0;
    } catch {
        return false;
    }
}

// 首次克隆：部分克隆 + 稀疏检出，仅拉取 docs/ 与根目录文件（mkdocs.yml），体积远小于完整克隆
async function cloneFresh(url: string): Promise<void> {
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    console.log(`[oiwiki] 开始同步 OI Wiki 源码（sparse clone）：${url}`);
    await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', branchName, '--single-branch', url, cacheDir]);
    await git(['sparse-checkout', 'set', 'docs'], cacheDir);
    if (!isReady()) throw new Error('克隆完成但未找到 mkdocs.yml，请检查仓库结构');
    console.log('[oiwiki] OI Wiki 源码同步完成');
}

async function updateExisting(url: string): Promise<void> {
    let remote = '';
    try {
        remote = (await git(['remote', 'get-url', 'origin'], cacheDir)).trim();
    } catch { /* ignore */ }
    if (remote && remote !== url) await git(['remote', 'set-url', 'origin', url], cacheDir);
    await git(['fetch', '--depth', '1', 'origin', branchName], cacheDir);
    await git(['reset', '--hard', 'FETCH_HEAD'], cacheDir);
    await git(['sparse-checkout', 'set', 'docs'], cacheDir);
    if (!isReady()) throw new Error('更新完成但未找到 mkdocs.yml，请检查仓库结构');
    console.log('[oiwiki] OI Wiki 源码已更新');
}

let updating: Promise<void> | null = null;
let lastFailAt = 0;

// 先探连通性再同步：不可达的源直接跳过，可达源里按优先级（上次成功的优先）依次尝试。
async function syncAll(): Promise<void> {
    const targets = orderedTargets();
    const reachable: string[] = [];
    for (const url of targets) {
        if (await probe(url)) reachable.push(url);
        else console.warn(`[oiwiki] 源不可达，跳过：${url}`);
    }
    if (!reachable.length) throw new Error(`所有候选源均无法连通：${targets.join(' , ')}`);

    const isRepo = fs.existsSync(path.join(cacheDir, '.git'));
    let lastErr: Error | null = null;
    if (isRepo) {
        for (const url of reachable) {
            try {
                await updateExisting(url);
                activeUrl = url;
                return;
            } catch (e) {
                lastErr = e as Error;
                console.warn(`[oiwiki] 从 ${url} 更新失败：${lastErr.message}`);
            }
        }
        console.warn('[oiwiki] 所有可达源更新均失败，尝试删除缓存重新克隆以自愈');
    }
    for (const url of reachable) {
        try {
            await cloneFresh(url);
            activeUrl = url;
            return;
        } catch (e) {
            lastErr = e as Error;
            console.warn(`[oiwiki] 从 ${url} 克隆失败：${lastErr.message}`);
        }
    }
    throw lastErr ?? new Error('源码同步失败');
}

// 幂等触发更新：并发调用共享同一 promise；定时/页面自动触发失败后 10 分钟内不再重试；force=true 供管理员脚本手动重试
export function updateCache(force = false): Promise<void> {
    if (updating) return updating;
    if (!force && lastFailAt && Date.now() - lastFailAt < 10 * 60 * 1000) return Promise.resolve();
    updating = syncAll()
        .catch((e) => {
            lastFailAt = Date.now();
            console.error('[oiwiki] 源码同步失败：', e.message);
            console.error('[oiwiki] 插件会先用 git ls-remote 探测各候选源（主仓库与 mirrors 备用源）连通性，只对可达的源发起同步；若全部不可达，请更新 repo / mirrors 配置指向可用镜像，或设置 proxy 加速前缀（如 https://gh-proxy.com/ ）。');
        }).finally(() => { updating = null; });
    return updating;
}

// OI Wiki 的文档与图片等静态资源都位于仓库的 docs/ 目录下
export function docsPath(rel: string): string {
    return path.resolve(cacheDir, 'docs', rel);
}

// 路径穿越防护：仅允许访问缓存目录 docs/ 内的真实文件
export function safeJoinDocs(sub: string): string | null {
    const target = path.resolve(cacheDir, 'docs', sub);
    const root = path.resolve(cacheDir, 'docs');
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return target;
}
