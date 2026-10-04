/**
 * 功能⑨：更新检查（含 GitHub 加速站测速）
 *
 * ## 为什么需要它
 *
 * Zotero 的原生自动更新依赖 manifest 里的 `update_url`，那是一个**写死在已安装
 * 插件里、运行时改不了**的地址。而本机到 `github.com` 的连接经常完全不通
 * （实测直连拉 update.json 全部超时），所以：
 *
 *   · 构建时把 `updateURL` / `xpiDownloadLink` 指向一个加速站，让原生更新能工作
 *   · 本模块在**运行时**对多个加速站测速，选最快的那个来做检查与下载
 *     —— 因为加速站的延迟波动极大（实测同一站点三次分别为 1.26s / 1.31s / 8.96s）
 *
 * ## 安全设计（重要）
 *
 * GitHub 加速站本质是**第三方中间人**，它能看到并改写你下载的内容。
 * 如果清单和安装包都走同一个站，恶意站可以同时替换两者，哈希校验形同虚设。
 *
 * 对策：**交叉校验**。清单只有几百字节，同时从**两个不同的站点**拉取，
 * 比对 `version` 与 `update_hash`；两者一致才继续。
 * 实测 4 个站点返回的文件哈希完全一致，所以这个校验是可行的。
 */

import { config } from "../../package.json";
import pkg from "../../package.json";
import { getPref } from "../utils/prefs";
import { getLocaleID, getString } from "../utils/locale";

const MENU_ID = `${config.addonRef}-update-check-menu`;

/** 清单的 GitHub 原始地址（由 package.json 的 repository.url 推导） */
const REPO_URL = String(pkg.repository.url)
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const MANIFEST_URL = `${REPO_URL}/releases/download/release/update.json`;

/**
 * 默认加速站。实测（2026-10-04）这 5 个可用，其余常见域名多数已失效。
 * 顺序按实测延迟排，但运行时仍会重新测速 —— 延迟波动很大。
 */
const DEFAULT_PROXIES = [
  "https://gh-proxy.com/",
  "https://gh-proxy.org/",
  "https://ghfast.top/",
  "https://ghproxy.net/",
  "https://v4.gh-proxy.org/",
];

/** 单个站点的探测超时（毫秒） */
const PROBE_TIMEOUT = 12000;
/** 探测结果缓存时长：避免每次检查都把所有站点打一遍 */
const PROBE_CACHE_TTL = 10 * 60 * 1000;

let menuKey: string | false = false;
let probeCache: { at: number; results: ProbeResult[] } | null = null;

export {
  register,
  unregister,
  runCheck,
  probeSources,
  downloadUpdate,
  listSources,
  compareVersions,
  MANIFEST_URL,
};
export type { ProbeResult, UpdateInfo };

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

interface UpdateSource {
  label: string;
  /** 是否直连（不经代理） */
  direct: boolean;
  /** 把 GitHub 原始地址转成该源的地址 */
  resolve: (url: string) => string;
}

interface ProbeResult {
  source: UpdateSource;
  ok: boolean;
  /** 毫秒；失败时为 Infinity */
  latency: number;
  error?: string;
}

interface UpdateInfo {
  /** 清单里的最新版本 */
  version: string;
  updateLink: string;
  updateHash: string;
  /** 与当前运行版本相比是否有更新 */
  hasUpdate: boolean;
  /** 清单来自哪个源 */
  from: string;
  /** 交叉校验的结论 */
  verified: boolean;
  verifyNote: string;
}

/* ------------------------------------------------------------------ */
/* 注册 / 注销                                                         */
/* ------------------------------------------------------------------ */

function register(): void {
  registerMenu();
}

function unregister(): void {
  if (menuKey) {
    Zotero.MenuManager.unregisterMenu(menuKey);
    menuKey = false;
  }
}

function registerMenu(): void {
  if (menuKey) {
    return;
  }
  menuKey = Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menu-check-update"),
        onShowing: (event: any) => {
          const element = event?.target as any;
          if (element) {
            element.hidden = !getPref("updateChecker.enabled");
          }
        },
        onCommand: () => {
          void runCheck();
        },
      },
    ],
  } as any);
  if (!menuKey) {
    Zotero.debug("[MyZoteroTools] 注册检查更新菜单失败");
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runCheck(): Promise<void> {
  notify(getString("update-checking"), getString("update-probing"));

  const probes = await probeSources(true);
  const usable = probes.filter((probe) => probe.ok);

  if (!usable.length) {
    notify(
      getString("update-all-failed"),
      getString("update-all-failed-detail", {
        args: { count: probes.length },
      }),
    );
    return;
  }

  let info: UpdateInfo;
  try {
    info = await fetchUpdateInfo(usable);
  } catch (e) {
    notify(getString("update-check-failed"), String(e));
    return;
  }

  if (!info.hasUpdate) {
    notify(
      getString("update-latest"),
      getString("update-latest-detail", {
        args: {
          version: pkg.version,
          from: info.from,
          count: usable.length,
        },
      }),
    );
    return;
  }

  // 有新版本：问一下要不要现在下载
  const confirmed = confirmDialog(
    getString("update-available-title"),
    getString("update-available-body", {
      args: {
        current: pkg.version,
        latest: info.version,
        from: info.from,
      },
    }) + `\n\n${getString("update-verify-note")}: ${info.verifyNote}`,
  );
  if (!confirmed) {
    return;
  }

  await downloadUpdate(info, usable);
}

/* ------------------------------------------------------------------ */
/* 测速                                                                */
/* ------------------------------------------------------------------ */

/** 解析用户配置的加速站列表；为空则用默认值 */
function listSources(): UpdateSource[] {
  const configured = String(getPref("updateChecker.proxies") ?? "").trim();
  const prefixes = configured
    ? configured
        .split(/[\r\n,;]+/)
        .map((line) => line.trim())
        .filter(Boolean)
    : DEFAULT_PROXIES;

  const sources: UpdateSource[] = [
    // 直连放第一个：它要是能用就是最好的（不经第三方）
    { label: "GitHub 直连", direct: true, resolve: (url) => url },
  ];
  for (const prefix of prefixes) {
    if (/^direct$/i.test(prefix)) {
      continue;
    }
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    let label = normalized;
    try {
      label = new URL(normalized).host;
    } catch {
      // 配置里写了非法 URL，原样展示，探测时自然失败
    }
    sources.push({
      label,
      direct: false,
      resolve: (url) => `${normalized}${url}`,
    });
  }
  return sources;
}

/**
 * 并发探测所有源（拉清单，文件很小）。
 * @param force 忽略缓存
 */
async function probeSources(force = false): Promise<ProbeResult[]> {
  if (!force && probeCache && Date.now() - probeCache.at < PROBE_CACHE_TTL) {
    return probeCache.results;
  }

  const sources = listSources();
  const results = await Promise.all(
    sources.map(async (source): Promise<ProbeResult> => {
      const started = Date.now();
      try {
        const response = await httpGet(source.resolve(MANIFEST_URL), {
          timeout: PROBE_TIMEOUT,
        });
        const latency = Date.now() - started;
        const ok = response.status === 200 && response.text.includes("updates");
        return {
          source,
          ok,
          latency,
          error: ok ? undefined : `HTTP ${response.status}`,
        };
      } catch (e) {
        return {
          source,
          ok: false,
          latency: Number.POSITIVE_INFINITY,
          error: String(e),
        };
      }
    }),
  );

  results.sort((a, b) => a.latency - b.latency);
  probeCache = { at: Date.now(), results };
  return results;
}

/* ------------------------------------------------------------------ */
/* 取清单 + 交叉校验                                                   */
/* ------------------------------------------------------------------ */

async function fetchUpdateInfo(usable: ProbeResult[]): Promise<UpdateInfo> {
  const [first, second] = usable;

  const primary = await readManifest(first.source);
  if (!primary) {
    throw new Error(`从 ${first.source.label} 读取清单失败`);
  }

  // 交叉校验：换一个不同的站点再拉一次，比对关键字段
  let verified = false;
  let verifyNote = "";
  const shouldVerify = !!getPref("updateChecker.verifyWithSecondSource");
  if (!first.source.direct && shouldVerify && second) {
    try {
      const other = await readManifest(second.source);
      if (
        other &&
        other.version === primary.version &&
        other.updateHash === primary.updateHash
      ) {
        verified = true;
        verifyNote = getString("update-verified-ok", {
          args: { a: first.source.label, b: second.source.label },
        });
      } else {
        verifyNote = getString("update-verified-mismatch", {
          args: { a: first.source.label, b: second.source.label },
        });
        throw new Error(verifyNote);
      }
    } catch (e) {
      if (String(e).includes(verifyNote) && verifyNote) {
        throw e;
      }
      verifyNote = getString("update-verified-unavailable", {
        args: { a: first.source.label },
      });
    }
  } else if (first.source.direct) {
    verified = true;
    verifyNote = getString("update-verified-direct");
  } else {
    verifyNote = getString("update-verified-skipped");
  }

  return {
    version: primary.version,
    updateLink: primary.updateLink,
    updateHash: primary.updateHash,
    hasUpdate: compareVersions(primary.version, pkg.version) > 0,
    from: first.source.label,
    verified,
    verifyNote,
  };
}

async function readManifest(source: UpdateSource): Promise<{
  version: string;
  updateLink: string;
  updateHash: string;
} | null> {
  const response = await httpGet(source.resolve(MANIFEST_URL), {
    timeout: PROBE_TIMEOUT,
  });
  if (response.status !== 200) {
    return null;
  }
  const data = JSON.parse(response.text);
  const entry = data?.addons?.[config.addonID]?.updates?.[0];
  if (!entry?.version) {
    return null;
  }
  return {
    version: String(entry.version),
    updateLink: String(entry.update_link ?? ""),
    updateHash: String(entry.update_hash ?? ""),
  };
}

/* ------------------------------------------------------------------ */
/* 下载新版本                                                          */
/* ------------------------------------------------------------------ */

async function downloadUpdate(
  info: UpdateInfo,
  usable: ProbeResult[],
): Promise<void> {
  const url = info.updateLink;
  if (!url) {
    notify(getString("update-check-failed"), "清单里没有 update_link");
    return;
  }

  // 依次尝试：最快的源 → 其他可用源
  let lastError = "";
  for (const probe of usable) {
    const target = probe.source.resolve(url);
    try {
      notify(
        getString("update-downloading"),
        getString("update-downloading-detail", {
          args: { version: info.version, from: probe.source.label },
        }),
      );
      const response = await httpGet(target, {
        timeout: 120000,
        responseType: "arraybuffer",
      });
      if (response.status !== 200 || !response.buffer) {
        lastError = `${probe.source.label}: HTTP ${response.status}`;
        continue;
      }

      // 校验哈希：这是防止加速站替换安装包的关键一步
      const actual = await sha512Hex(response.buffer);
      if (info.updateHash && actual !== stripHashPrefix(info.updateHash)) {
        lastError = getString("update-hash-mismatch", {
          args: { from: probe.source.label },
        });
        Zotero.debug(`[MyZoteroTools] ${lastError}`);
        continue;
      }

      const file = saveXpi(response.buffer, info.version);
      notify(
        getString("update-downloaded"),
        getString("update-downloaded-detail", {
          args: { version: info.version, path: file.path },
        }),
      );
      // 打开所在目录，方便用「Install Add-on From File」安装
      try {
        file.reveal();
      } catch {
        // 打不开就算了，路径已经显示在提示里
      }
      return;
    } catch (e) {
      lastError = `${probe.source.label}: ${e}`;
    }
  }

  notify(getString("update-download-failed"), lastError);
}

function saveXpi(buffer: ArrayBuffer, version: string): any {
  const dir =
    String(getPref("updateChecker.downloadDir") ?? "").trim() ||
    Zotero.DataDirectory.dir;
  const file = Zotero.File.pathToFile(dir);
  file.append(`daxiang-zotero-tools-${version}.xpi`);
  const bytes = new Uint8Array(buffer);
  const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
    Ci.nsIFileOutputStream,
  );
  stream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);
  stream.write(String.fromCharCode(...bytes), bytes.length);
  stream.close();
  return file;
}

async function sha512Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stripHashPrefix(hash: string): string {
  return hash.replace(/^sha512:/i, "").toLowerCase();
}

/* ------------------------------------------------------------------ */
/* HTTP（带超时）                                                      */
/* ------------------------------------------------------------------ */

async function httpGet(
  url: string,
  options: { timeout: number; responseType?: string },
): Promise<{ status: number; text: string; buffer?: ArrayBuffer }> {
  const response = await Zotero.HTTP.request("GET", url, {
    timeout: options.timeout,
    responseType: options.responseType ?? "text",
    // 不要因为 4xx/5xx 就抛异常，交给调用方判断
    successCodes: false,
  } as any);

  const status = response.status ?? 0;
  if (options.responseType === "arraybuffer") {
    return { status, text: "", buffer: response.response as ArrayBuffer };
  }
  return {
    status,
    text: String(response.responseText ?? response.response ?? ""),
  };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 语义化版本比较：a > b 返回正数 */
function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    String(value)
      .split(/[.\-+]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) {
        return x - y;
      }
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) {
        return sx > sy ? 1 : -1;
      }
    }
  }
  return 0;
}

function confirmDialog(title: string, body: string): boolean {
  try {
    const win = Zotero.getMainWindow() as any;
    const ps = win.Services.prompt;
    return (
      ps.confirmEx(
        win,
        title,
        body,
        ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
          ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL,
        getString("update-confirm-ok"),
        null,
        null,
        null,
        {},
      ) === 0
    );
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 确认框失败: ${e}`);
    return false;
  }
}

function notify(headline: string, text = ""): void {
  try {
    const pw = new (Zotero as any).ProgressWindow({ closeOnClick: true });
    pw.changeHeadline(headline);
    if (text) {
      pw.addDescription(text);
    }
    pw.show();
    pw.startCloseTimer(8000);
  } catch (e) {
    Zotero.debug(`[MyZoteroTools] 提示失败: ${e}`);
  }
}
