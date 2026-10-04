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
   * 两个地址都指向 GitHub Release 的资产：
   *   · update.json  由 `npm run release` 生成，Zotero 定期拉取它来比对版本
   *   · xpi          由 update.json 里的链接指向，Zotero 下载后自动升级
   *
   * ⚠️ 仓库必须是**公开**的：Zotero 拉 update.json 时不会带任何凭据，
   * 私有仓库的 Release 资产它拿不到，自动更新会静默失效。
   */
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

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
