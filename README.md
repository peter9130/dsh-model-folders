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

这是一个 DeepSeek Harness（DSH）Web 插件 bundle，两种装法都行。

### 方式一：下载 Release 安装包（推荐）

1. 打开 [Releases](https://github.com/peter9130/dsh-model-folders/releases/latest)，下载 `dsh-model-folders-1.0.0.tgz`。
2. 在 DSH 里把 tgz 的绝对路径交给插件管理器安装：

   ```text
   用 plugin_manager 的 install_bundle，安装 /绝对路径/dsh-model-folders-1.0.0.tgz
   ```

   或者把 tgz 放进任意目录，在 DSH 里说「安装 /path/to/dsh-model-folders-1.0.0.tgz」，由 Agent 调用 `plugin_manager` 完成。

3. 按提示重启 DSH（或到「设置 → 插件」里对 `dsh-model-folders` 禁用再启用）。
   浏览器端（`client.js`）由 client-hmr 热加载，约 10 秒生效；宿主端（`index.js` /
   `cordis.patch.yml`）需要重启或重新启用。

### 方式二：从源码目录安装

```bash
git clone https://github.com/peter9130/dsh-model-folders.git
```

然后在 DSH 里用 `plugin_manager install_bundle` 指向克隆下来的目录（或把目录放进
`~/.dsh/profiles/<profile>/vendor/` 后安装），开发时也可以直接 `link:` 到该目录。

### 方式三：从 GitHub 源码安装

```text
用 plugin_manager 安装 github:peter9130/dsh-model-folders
```

GitHub 源码安装走 pnpm 的 git 拉取，国内网络可能很慢；优先用方式一的 tarball。

## 卸载 / Uninstall

在「设置 → 插件」里禁用并删除该 bundle，或从 profile 的 `package.json`
（`dependencies` 与 `dsh.profile.bundles`）里去掉 `dsh-model-folders` 后重新安装依赖。
