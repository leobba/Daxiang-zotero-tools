import { defineConfig } from "zotero-plugin-scaffold";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import pkg from "./package.json";

/**
 * `zotero-plugin test` 会把测试数据目录（.scaffold/test/data）清空重建，
 * 所以无法通过环境变量把「真实库」喂给它。这里利用脚手架提供的 test:init 钩子
 * ——它在清空目录之后、启动 Zotero 之前执行——把指定的数据库快照投放进去。
 *
 * 用法：设置 MYZOTEROTOOLS_TEST_DB 指向一个 zotero.sqlite 快照即可；
 *       不设置时，测试会跑在空白库上（此时依赖真实数据的用例会明确报错，
 *       而不是悄悄通过）。
 */
const TEST_DATA_DIR = ".scaffold/test/data";

/**
 * GitHub 加速站前缀。实测（2026-10-04）本机直连 github.com 完全不通，
 * 而下面这个站可用（拉 update.json 约 0.6~0.9s）。
 *
 * 设成空字符串 "" 即恢复直连。
 * 改这里之后必须重新构建 + 重新发布，因为 update_url 会被烘焙进 manifest。
 */
const PROXY_PREFIX = "https://gh-proxy.com/";

function seedTestDatabase() {
  const source = process.env.MYZOTEROTOOLS_TEST_DB;
  if (!source || !existsSync(source)) {
    return;
  }
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  copyFileSync(source, `${TEST_DATA_DIR}/zotero.sqlite`);
  for (const extra of ["fulltext.sqlite"]) {
    const from = source.replace(/zotero\.sqlite$/, extra);
    if (existsSync(from)) {
      copyFileSync(from, `${TEST_DATA_DIR}/${extra}`);
    }
  }
  console.log(`[test:init] 已投放数据库快照: ${source}`);
}

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  /*
   * 自动更新的地址。
   *
   * `{{owner}}` / `{{repo}}` 是 scaffold 从 package.json 的 `repository.url`
   * 解析出来的模板变量 —— 所以【换仓库只需要改 package.json 那一处】。
   *
   * ⚠️ 这里刻意套了一层 **GitHub 加速站**（`PROXY_PREFIX`）：
   * 本机到 github.com 的连接实测**完全不通**（直连拉 update.json 全部超时），
   * 不套代理的话 Zotero 的原生自动更新永远拉不到清单，而且是**静默失效**。
   *
   * 代价与对策：
   *   · 加速站是第三方中间人，理论上能替换安装包；
   *   · 但 manifest 里的 update_url 是**写死在已安装插件里、运行时改不了**的，
   *     所以这里只能固定一个相对可靠的站；
   *   · 插件内置的「检查更新」功能（src/modules/updateChecker.ts）会在运行时
   *     对多个加速站测速，并**交叉校验**清单（两个不同站点的 version +
   *     update_hash 必须一致），比这里写死的这一个更可信。
   *
   * 想换加速站：改下面的 PROXY_PREFIX，重新构建并发布。
   * 想不用代理：把 PROXY_PREFIX 设成空字符串即可。
   */
  updateURL: `${PROXY_PREFIX}https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    // ⚠️ 必须是 `v{{version}}` —— Release 的 tag 带 v 前缀（v0.2.1）。
    //    写成 `{{version}}` 会得到 .../download/0.2.1/... 直接 404，
    //    而 Zotero 的更新失败是**静默**的，很难发现。
    `${PROXY_PREFIX}https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi`,

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        // 设置面板专用脚本。
        // Zotero 用 `PreferencePanes.register({ scripts })` 加载它，底层是
        // `Services.scriptloader.loadSubScript()` —— 那是**经典脚本**加载器，
        // 不支持 ESM，因此这里必须打成 iife 且不产出 import/export。
        entryPoints: ["src/preferences.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        format: "iife",
        target: "firefox140",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}-preferences.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    hooks: {
      "test:init": () => {
        seedTestDatabase();
      },
    },
  },

  server: {
    // 开发时不自动弹出 Browser Toolbox；调试输出已由 debugOutputFile 落到 .scaffold/logs/
    devtools: false,
    debugOutputFile: true,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
