# Model folders

Folder-first model picker for the DeepSeek Harness Web composer.

The composer's model menu (the control left of the send button) normally lists
every model inline, grouped by provider. This bundle replaces that menu with a
folder layer: choose a folder first, then the model inside it.

## Two ways to organize

A compact segmented switch at the top of the model list chooses the folder axis:

- **By provider** — one folder per provider in the live catalog. The provider
  folder holds that provider's models, and the folder containing the current
  selection carries a check mark.
- **By model family** — one folder per model family (DeepSeek, Kimi, GLM,
  Gemini, Claude, GPT, Qwen, Llama, Mistral, Grok, MiniMax, Doubao, Hunyuan,
  ERNIE, StepFun, Yi, MiMo, Nemotron, Command, Phi, Nova). Models from every
  provider land in their family folder and show their provider beneath the
  name. A model that matches no known family is grouped by the first word of
  its display name, and anything left over falls into **Other models**.

The choice is remembered in this browser (`localStorage`, key
`dsh.model-folders.mode`). It does not create a Host setting and does not
change another browser profile.

## Usage

1. Click the model control in the composer tool row.
2. Pick **Model** to open the folder list; the segmented switch and the search
   field (shown when the catalog has more than four models) sit at the top.
3. Pick a folder, then a model. **Reasoning effort** remains a separate row in
   the root menu for models that advertise effort levels, and a slider panel
   below the two rows switches the effort directly (drag, or focus it and use
   ←/→; it commits once per gesture, and the shipped extension list is still
   rendered when the stock selector owns the seat).
4. Keyboard: from the trigger, Tab enters the folder pane at the grouping
   switch; ←/→ switches the grouping, and another Tab reaches search and the
   rows. Tab settles the focused row, and Escape or Shift+Tab backs out one
   pane.

Search matches model names and ids case-insensitively, including non-consecutive
characters, and shows flat results with their provider.

## What it reuses

The picker reads the same per-session model directory as the shipped selector
(`ctx.modelDirectories`: the shared Host model catalog plus the session's
durable model selection) and submits through `session.selectModel`. Switching
therefore stays one click and both entries stay in sync.

## Requirements and limits

- Requires the built-in model selection client package
  (`@deepseek-ai/dsh-client-ui-model-selection`); the plugin stays inactive
  without it, and it is declared under `dsh.client.inject` so the module graph
  loads it first.
- **Composer menu only.** The `/model` command popup keeps the stock flat
  provider list.
- The seat is shadowed at a lower slot priority, so rows other plugins append
  to that menu (`conversation.input.model.options` / `.label`) are not shown by
  this picker. No extra Host service, credential, or network request is added.
- Disabling the bundle restores the stock flat model menu on the next page
  synchronization.

## Implementation

- `client.js` — the browser half: the slot occupant registered at
  `conversation.input.model`, its folder/family/search/effort panes, own SVG
  icons, and component-local CSS (`dmf-` prefix, `--dsw-alias-*` tokens only).
- `index.js` — no-op Host half; the Loader row carries the browser half.
- `cordis.patch.yml` — the single bundle row.

## 安装 / Installation

这是一个 DeepSeek Harness（DSH）Web 插件 bundle，三种装法任选。

### 方式一：npm 安装（推荐）

在 DSH 里直接让插件管理器按包名安装：

```text
用 plugin_manager 安装 dsh-model-folders@1.0.1
```

国内网络访问 npm 源通常比 GitHub 快；也可以先 `npm view dsh-model-folders version` 确认版本。

### 方式二：下载 Release 安装包（离线）

1. 打开 [Releases](https://github.com/peter9130/dsh-model-folders/releases/latest)，下载 `dsh-model-folders-1.0.1.tgz`。
2. 把它交给 DSH 的插件管理器：

   ```text
   用 plugin_manager 的 install_bundle 安装 /绝对路径/dsh-model-folders-1.0.1.tgz
   ```

### 方式三：从源码目录安装（开发）

```bash
git clone https://github.com/peter9130/dsh-model-folders.git
```

然后在 DSH 里用 `plugin_manager install_bundle` 指向该目录，或把目录放进
`~/.dsh/profiles/<profile>/vendor/` 后安装；开发时也可以直接 `link:` 到该目录。

## 升级 / Upgrade

```text
用 plugin_manager 把 dsh-model-folders 升级到最新版本
```

或重新执行一次安装并指定新版本号（如 `dsh-model-folders@1.0.2`）。

## 卸载 / Uninstall

在「设置 → 插件」里禁用并删除该 bundle，或从 profile 的 `package.json`
（`dependencies` 与 `dsh.profile.bundles`）里去掉 `dsh-model-folders` 后重新安装依赖。

宿主端（`index.js` / `cordis.patch.yml`）改动需要重启或禁用再启用；浏览器端
（`client.js`）由 client-hmr 热加载，约 10 秒生效。
