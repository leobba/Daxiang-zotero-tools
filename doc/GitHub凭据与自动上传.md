# 怎么获取 GitHub 凭据，以及怎么让 AI 自动上传

> 面向「我不想手动点网页，想让 AI 把仓库建好、代码推上去、Release 建好、自动更新跑通」这个目标。

---

## 一、为什么需要凭据

建仓库、推代码、建 Release 都是**写操作**，GitHub 必须知道你是谁。这台机器上目前：

- ❌ 没有 `gh` CLI
- ❌ 没有保存的凭据（`.git-credentials` 不存在）
- ❌ 环境变量里没有 token
- ✅ 有 Git Credential Manager，但它只会弹交互窗口，AI 点不了

所以**必须你提供一次 token**。给一次，我就能全部做完。

## 二、要哪种 token

用 **Classic Personal Access Token**（不是 Fine-grained），勾 **两个** scope：

| Scope | 为什么需要 |
|---|---|
| `repo` | 建仓库、推代码、建 Release |
| `workflow` | **必须**。仓库里有 `.github/workflows/release.yml`，GitHub 规定推送 workflow 文件必须带这个 scope，否则会拒绝推送并报 `refusing to allow a Personal Access Token to create or update workflow` |

> Fine-grained token 也能做，但「建一个新仓库」需要账号级权限，配置起来更绕。Classic 更省事。

## 三、四步拿到 token

1. 浏览器打开 **https://github.com/settings/tokens/new**
   （或：GitHub 右上角头像 → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token (classic)）

2. 填两个字段：
   - **Note**：`MyZoteroTools 自动发布`
   - **Expiration**：`30 days`（够用，发布完可以立刻撤销）

3. 勾选 scope：
   - ☑ **`repo`**（勾最上面那个大项，子项会自动全选）
   - ☑ **`workflow`**

4. 拉到底点 **Generate token**，复制那串 `ghp_xxxxxxxx...`
   ⚠️ **只显示这一次**，关掉页面就再也看不到了（看不到就重新生成一个）

## 四、怎么把 token 给我

**方式 A（推荐）**：自己写进 `.env`

用记事本打开（没有就新建）：

```
E:\code\deepseek杂项\zotero-smart-collections\.env
```

加一行：

```
GITHUB_TOKEN=ghp_把这里换成你的token
```

保存后告诉我「放好了」。`.env` 已经在 `.gitignore` 里（第 13 行），**不会被提交**。

**方式 B**：直接把 token 发在对话里，我替你写进 `.env`。

> 两种方式 token 都会落到你本机磁盘上。这是必要的——推送必须要它。
> **发布完成后你可以立刻去 GitHub 撤销这个 token**，之后日常发版不再需要它（见第六节）。

## 五、拿到之后我会做什么

| 步骤 | 动作 |
|---|---|
| 1 | 用 API 建**公开**仓库 `leobba/myzoterotools` |
| 2 | 配 `git remote`，推送 `main` 分支（73 个文件） |
| 3 | 打 tag `v0.2.0` 并推送 → 触发 GitHub Actions |
| 4 | 盯着 Actions 跑完（`npm ci` → `npm run build` → `npm run release`） |
| 5 | 验证 Release 里有 **xpi**，且 `release` 那个 Release 里有 **update.json** |
| 6 | 用 curl 验证 `update_url` 真能拉到 JSON、xpi 真能下载 |
| 7 | 告诉你结果，并提醒你可以撤销 token 了 |

**第 5、6 步是关键**：光看 Actions 变绿不够，要真的能拉到 `update.json`，
Zotero 的自动更新才算通。

## 六、之后日常发版（不需要本地 token）

配好之后，你本地只需要：

```powershell
npm run release:minor     # 0.2.0 → 0.3.0（加功能）
git push origin main --follow-tags
```

`release:minor` 在本地会：改版本号 → 构建 → 提交 → 打 tag。
`git push --follow-tags` 把 tag 推上去 → **GitHub Actions 用仓库自带的
`GITHUB_TOKEN` 建 Release**（不需要你提供任何 token）。

版本号级别怎么选：

| 命令 | 什么时候用 |
|---|---|
| `npm run release:patch` | 修 bug：0.2.0 → 0.2.1 |
| `npm run release:minor` | 加功能：0.2.0 → 0.3.0 |
| `npm run release:major` | 不兼容变更：0.2.0 → 1.0.0 |

## 七、自动更新是怎么生效的

```
Zotero 启动
  └─ 读插件 manifest 里的 update_url
       = https://github.com/leobba/myzoterotools/releases/download/release/update.json
       └─ 拉这个固定地址的 JSON
            ├─ 里面的 version 不高于当前 → 什么都不做
            └─ 更高 → 按 update_link 下载 xpi → 安装
```

**三个前提**（缺一个就静默失效）：

1. **仓库必须公开** —— Zotero 拉 JSON 时不带任何凭据，私有仓库的 Release 资产它拿不到
2. **`release` 那个 Release 必须存在且含 `update.json`** —— 由 `npm run release` 在 CI 里自动维护
3. **`update_url` 必须指向上面那个固定地址** —— 已由脚手架从 `package.json` 的
   `repository.url` 自动生成，构建后可以在 `manifest.json` 里核对

## 八、常见问题

**Q：token 泄露了怎么办？**
立刻去 https://github.com/settings/tokens 把它 Revoke 掉，然后重新生成一个。
token 只能操作你的仓库，撤销后立即失效。

**Q：能不能不用 token？**
可以，但那样就得你自己在网页上建仓库、自己 `git push`（Git Credential Manager 会弹窗让你登录）。
AI 没法替你点那个弹窗。

**Q：为什么必须公开仓库？我不想公开。**
公开的只是**插件代码**（不含你的文献库——`.gitignore` 已经挡掉了 `.research`、`.testkit`、
`*.xpi` 和所有 sqlite 文件）。如果一定要私有，那自动更新就用不了，以后每次升级你手动装 xpi。
