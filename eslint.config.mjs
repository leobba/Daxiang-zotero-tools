// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  // .testkit 数据目录里含 Zotero 自带的 translators 脚本（非本项目代码），
  // .scaffold 是构建产物，都不应参与 lint。
  ignores: [".testkit/**", ".scaffold/**", "node_modules/**"],
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // 插件里需要与 Zotero 未公开类型的内部 API 打交道，
        // 这些位置刻意使用 any 并配有注释说明原因。
        "@typescript-eslint/no-explicit-any": "off",
      },
    },
  ],
});
