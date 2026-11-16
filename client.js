/**
 * Model folders — browser half.
 *
 * The composer's `conversation.input.model` seat is a single slot occupied by
 * the shipped model selector at priority 0. This plugin registers its own
 * occupant at priority -1 (the lowest priority renders), so the folder picker
 * shadows the stock menu while keeping the same data path: the per-session
 * `ctx.modelDirectories` directory, the shared model catalog, and
 * `session.selectModel`.
 *
 * Layout: trigger -> root cells (model / reasoning effort / grouping) ->
 * folder list -> one folder's models, with an effort pane and a grouping pane.
 * Models are grouped either per provider (folder = provider) or per model
 * family (folder = DeepSeek, Kimi, Gemini, ... inferred from the model id and
 * display name). The grouping choice lives in localStorage.
 *
 * The picker writes its own controls and styles (renamed under the `dmf-`
 * prefix) instead of importing Harness Client packages, and reads only
 * `--dsw-alias-*` theme tokens so light/dark theming follows the host.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-model-folders',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')

    const h = React.createElement
    const NS = 'model-folders'
    const MODE_KEY = 'dsh.model-folders.mode'

    /* ------------------------------------------------------------------ *
     * Dictionaries
     * ------------------------------------------------------------------ */

    const zh = {
      'provider.account': 'DeepSeek 账号',
      'trigger.fallback': '请选择模型',
      'trigger.loading': '正在加载模型…',
      'trigger.selectAria': '请选择模型',
      'trigger.aria': '选择模型，当前 {model}',
      'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
      'menu.aria': '模型与推理等级',
      'menu.model': '模型',
      'menu.effort': '推理等级',
      'effort.sliderHint': '更快消耗使用额度',
      'effort.sliderAria': '推理等级：{name}',
      'effort.sliderPending': '正在切换到{name}…',
      'effort.sliderAnnounce': '推理等级已切换到{name}',
      'menu.grouping': '整理方式',
      'mode.provider': '按提供商',
      'mode.family': '按模型家族',
      'mode.providerHint': '每个提供商一个文件夹',
      'mode.familyHint': '按 DeepSeek、Kimi 等家族归类',
      'family.other': '其他模型',
      'effort.providerDefault': 'Default',
      'status.loading': '正在刷新模型列表…',
      'error.action': '模型操作失败：{message}',
      'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
      'action.reload': '重新加载',
      'warning.groupLoad': '{name} 加载失败：{message}',
      'search.placeholder': '搜索模型…',
      'search.clear': '清除搜索',
      'search.empty': '没有匹配的模型。',
      'empty.models': '暂无可用模型',
      'empty.efforts': '当前模型未提供推理等级。',
      'back': '返回',
    }

    const en = {
      'provider.account': 'DeepSeek Account',
      'trigger.fallback': 'Select model',
      'trigger.loading': 'Loading models…',
      'trigger.selectAria': 'Select model',
      'trigger.aria': 'Select model, current {model}',
      'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
      'menu.aria': 'Model and reasoning effort',
      'menu.model': 'Model',
      'menu.effort': 'Effort',
      'effort.sliderHint': 'Higher effort uses more quota',
      'effort.sliderAria': 'Reasoning effort: {name}',
      'effort.sliderPending': 'Switching to {name}…',
      'effort.sliderAnnounce': 'Reasoning effort set to {name}',
      'menu.grouping': 'Grouping',
      'mode.provider': 'By provider',
      'mode.family': 'By model family',
      'mode.providerHint': 'One folder per provider',
      'mode.familyHint': 'Grouped as DeepSeek, Kimi, Gemini, and so on',
      'family.other': 'Other models',
      'effort.providerDefault': 'Default',
      'status.loading': 'Refreshing model list…',
      'error.action': 'Model operation failed: {message}',
      'error.sessionInUse': 'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
      'action.reload': 'Reload',
      'warning.groupLoad': '{name} failed to load: {message}',
      'search.placeholder': 'Search models…',
      'search.clear': 'Clear search',
      'search.empty': 'No matching models.',
      'empty.models': 'No models available.',
      'empty.efforts': 'This model provides no reasoning effort levels.',
      'back': 'Back',
    }

    /* ------------------------------------------------------------------ *
     * Grouping preference: one module-level store every mounted seat shares.
     * ------------------------------------------------------------------ */

    function readMode() {
      try {
        const stored = window.localStorage.getItem(MODE_KEY)
        return stored === 'family' ? 'family' : 'provider'
      } catch {
        return 'provider'
      }
    }

    let modeValue = readMode()
    const modeListeners = new Set()

    function subscribeMode(listener) {
      modeListeners.add(listener)
      return () => { modeListeners.delete(listener) }
    }

    function getMode() {
      return modeValue
    }

    function setMode(next) {
      if (next === modeValue) return
      modeValue = next
      try {
        window.localStorage.setItem(MODE_KEY, next)
      } catch { /* storage is optional */ }
      for (const listener of [...modeListeners]) listener()
    }

    /** Adopt a grouping change written by another window on the same origin. */
    function syncModeFromStorage() {
      const next = readMode()
      if (next === modeValue) return
      modeValue = next
      for (const listener of [...modeListeners]) listener()
    }

    /* ------------------------------------------------------------------ *
     * Model families
     * ------------------------------------------------------------------ */

    /**
     * Build a token rule: a family token at a word boundary, tolerating digits
     * glued to the brand (`Qwen3`, `GLM4`, `gemini2`).
     * @param {readonly string[]} tokens - brand tokens matched case-insensitively.
     * @returns {RegExp}
     */
    function tokenRule(tokens) {
      return new RegExp(`(?:^|[^a-z0-9])(?:${tokens.join('|')})[0-9]*(?=$|[^a-z0-9])`, 'i')
    }

    /** Known families in display order; a hit claims the model before fallbacks. */
    const FAMILY_RULES = [
      { label: 'DeepSeek', pattern: /deepseek/i },
      { label: 'Kimi', pattern: tokenRule(['kimi', 'moonshot']) },
      { label: 'GLM', pattern: tokenRule(['glm', 'zhipu', 'chatglm']) },
      { label: 'Gemini', pattern: tokenRule(['gemini', 'bard']) },
      { label: 'Claude', pattern: tokenRule(['claude', 'anthropic']) },
      { label: 'GPT', pattern: tokenRule(['gpt', 'chatgpt', 'openai', 'codex', 'o[1-9]']) },
      { label: 'Qwen', pattern: tokenRule(['qwen', 'tongyi', 'qwq']) },
      { label: 'Llama', pattern: tokenRule(['llama', 'meta']) },
      { label: 'Mistral', pattern: tokenRule(['mistral', 'mixtral', 'codestral', 'devstral']) },
      { label: 'Grok', pattern: tokenRule(['grok', 'xai']) },
      { label: 'MiniMax', pattern: tokenRule(['minimax', 'abab']) },
      { label: 'Doubao', pattern: tokenRule(['doubao', 'volcengine', 'seed']) },
      { label: 'Hunyuan', pattern: tokenRule(['hunyuan', 'tencent']) },
      { label: 'ERNIE', pattern: tokenRule(['ernie', 'wenxin', 'baidu']) },
      { label: 'StepFun', pattern: tokenRule(['stepfun', 'step']) },
      { label: 'Yi', pattern: tokenRule(['yi', '01-ai', '01ai']) },
      { label: 'MiMo', pattern: tokenRule(['mimo', 'xiaomi']) },
      { label: 'Nemotron', pattern: tokenRule(['nemotron', 'nvidia']) },
      { label: 'Command', pattern: tokenRule(['command', 'cohere']) },
      { label: 'Phi', pattern: tokenRule(['phi']) },
      { label: 'Nova', pattern: tokenRule(['nova']) },
    ]

    /** Sort buckets: known families by rule order, derived families by label, other last. */
    const FAMILY_SORT_DERIVED = 1000
    const FAMILY_SORT_OTHER = 2000

    /**
     * Capitalize a derived family token.
     * @param {string} token - raw token.
     * @returns {string}
     */
    function capitalize(token) {
      return token.charAt(0).toUpperCase() + token.slice(1)
    }

    /**
     * Classify one catalog model into a family bucket.
     * @param {{ id: string, name: string }} model - catalog entry.
     * @returns {{ id: string, sort: number, label: string | undefined }}
     */
    function familyOf(model) {
      const haystack = `${model.name ?? ''} ${model.id ?? ''}`
      for (let index = 0; index < FAMILY_RULES.length; index += 1) {
        const rule = FAMILY_RULES[index]
        if (rule.pattern.test(haystack)) {
          return { id: `known:${rule.label.toLowerCase()}`, sort: index, label: rule.label }
        }
      }
      const first = /^[A-Za-z][A-Za-z0-9.+#-]*/.exec((model.name ?? '').trim())
      if (first !== null) {
        const token = first[0].replace(/[.\-+#]+$/, '')
        if (token.length > 0 && token.length <= 24) {
          return { id: `token:${token.toLowerCase()}`, sort: FAMILY_SORT_DERIVED, label: capitalize(token) }
        }
      }
      return { id: 'other', sort: FAMILY_SORT_OTHER, label: undefined }
    }

    /* ------------------------------------------------------------------ *
     * Provider and family folder units
     * ------------------------------------------------------------------ */

    /**
     * Put the account and official providers first, preserving other order.
     * @template {{ id: string }} T
     * @param {readonly T[]} groups - provider groups in catalog order.
     * @returns {T[]}
     */
    function orderProviders(groups) {
      const rank = (group) => group.id === 'deepseek-account' ? 0 : group.id === 'deepseek-official' ? 1 : 2
      return [...groups].sort((left, right) => rank(left) - rank(right))
    }

    /**
     * Localized display name of one provider group.
     * @param {{ id: string, name: string }} group - provider group.
     * @param {(key: string) => string} t - translate seat.
     * @returns {string}
     */
    function providerLabel(group, t) {
      if (group.id === 'deepseek-account') return t('provider.account')
      return group.name !== undefined && group.name !== '' ? group.name : group.id
    }

    /**
     * Build the folder units for the active grouping mode.
     * @param {'provider' | 'family'} mode - grouping axis.
     * @param {readonly any[]} groups - ordered provider groups.
     * @param {(key: string) => string} t - translate seat.
     * @returns {readonly { id: string, kind: string, label: string, entries: readonly any[] }[]}
     */
    function buildUnits(mode, groups, t) {
      if (mode === 'provider') {
        return groups.map((group) => {
          const provider = { id: group.id, name: providerLabel(group, t) }
          return {
            id: `provider:${group.id}`,
            kind: 'provider',
            label: provider.name,
            entries: group.models.map((model) => ({ group, provider, model })),
          }
        })
      }
      const buckets = new Map()
      for (const group of groups) {
        const provider = { id: group.id, name: providerLabel(group, t) }
        for (const model of group.models) {
          const family = familyOf(model)
          let bucket = buckets.get(family.id)
          if (bucket === undefined) {
            bucket = { id: `family:${family.id}`, kind: 'family', label: family.label ?? t('family.other'), sort: family.sort, entries: [] }
            buckets.set(family.id, bucket)
          }
          bucket.entries.push({ group, provider, model })
        }
      }
      return [...buckets.values()].sort((left, right) =>
        left.sort - right.sort || left.label.localeCompare(right.label))
    }

    /* ------------------------------------------------------------------ *
     * Search ranking
     * ------------------------------------------------------------------ */

    /**
     * Whether `query` appears in `text` as an ordered substring.
     * @param {string} query - lowercase query.
     * @param {string} text - lowercase haystack.
     * @returns {boolean}
     */
    function isSubsequence(query, text) {
      let at = 0
      for (let index = 0; index < text.length && at < query.length; index += 1) {
        if (text[index] === query[at]) at += 1
      }
      return at === query.length
    }

    /**
     * Rank model entries for a query: name prefix, id prefix, substring, subsequence.
     * @param {readonly any[]} entries - flat model entries.
     * @param {string} query - raw query.
     * @returns {readonly any[]}
     */
    function rankEntries(entries, query) {
      const needle = query.toLowerCase()
      const scored = []
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        const name = String(entry.model.name ?? '').toLowerCase()
        const id = String(entry.model.id ?? '').toLowerCase()
        let score
        if (name.startsWith(needle)) score = 0
        else if (id.startsWith(needle)) score = 1
        else if (name.includes(needle)) score = 2
        else if (id.includes(needle)) score = 3
        else if (isSubsequence(needle, name) || isSubsequence(needle, id)) score = 4
        else continue
        scored.push({ entry, score, index })
      }
      scored.sort((left, right) => left.score - right.score || left.index - right.index)
      return scored.map((item) => item.entry)
    }

    /* ------------------------------------------------------------------ *
     * Inline icons and the component-local stylesheet
     * ------------------------------------------------------------------ */

    const svg = { xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, focusable: 'false' }

    function ChevronDownIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 12, height: 12 },
        h('path', { d: 'M4 6.5 8 10.5 12 6.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function ChevronRightIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 12, height: 12 },
        h('path', { d: 'M6.5 4 10.5 8 6.5 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function ChevronLeftIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 12, height: 12 },
        h('path', { d: 'M9.5 4 5.5 8 9.5 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CheckIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 14, height: 14 },
        h('path', { d: 'M3.2 8.4 6.3 11.5 12.8 5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CloseIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 12, height: 12 },
        h('path', { d: 'M4 4 12 12 M12 4 4 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function ModelsIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 16, height: 16 },
        h('path', { d: 'M2.5 4.5h11 M2.5 8h11 M2.5 11.5h7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function FolderIcon({ className }) {
      return h('svg', { ...svg, className, viewBox: '0 0 16 16', width: 14, height: 14 },
        h('path', { d: 'M1.8 4.2c0-.66.54-1.2 1.2-1.2h2.9c.4 0 .78.2 1 .53l.62.87h5.5c.66 0 1.2.54 1.2 1.2v6.3c0 .66-.54 1.2-1.2 1.2H3c-.66 0-1.2-.54-1.2-1.2z', fill: 'currentColor' }))
    }

    function SpinnerIcon({ className }) {
      return h('span', { className: className === undefined ? 'dmf-spinner' : `${className} dmf-spinner`, 'aria-hidden': true })
    }

    const CSS = `
.dmf-root { position: relative; min-width: 0; }
.dmf-trigger { anchor-name: var(--dmf-anchor); display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 360px; height: 28px; padding: 0 4px 0 8px; border: none; border-radius: var(--dsw-radius-sm); outline: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; font-weight: 400; cursor: pointer; }
.dmf-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
@media (hover: hover) { .dmf-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dmf-trigger:focus-visible:not([data-selection-focus]) { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dmf-triggerLabel, .dmf-triggerEffort { display: var(--dsh-composer-model-text-display, block); }
.dmf-triggerLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmf-triggerEffort { flex-shrink: 1000; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-caption); }
.dmf-triggerIcon { display: var(--dsh-composer-model-icon-display, none); flex: 0 0 auto; }
.dmf-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.dmf-chevronOpen { transform: rotate(180deg); }
.dmf-menu { box-sizing: border-box; position: fixed; position-anchor: var(--dmf-anchor); top: max(12px, var(--dsh-frame-overlay-top, 12px)); left: 12px; right: anchor(right); bottom: calc(anchor(top) + 8px); align-self: safe end; justify-self: safe end; margin: 0; z-index: 1100; display: flex; flex-direction: column; isolation: isolate; width: fit-content; height: fit-content; min-width: min(240px, calc(100vw - 24px)); max-width: min(420px, calc(100vw - 24px)); max-height: min(360px, calc(100dvh - 96px)); overflow: hidden; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); font-family: inherit; }
.dmf-menu button { font-family: inherit; }
.dmf-material { position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: var(--dsw-menu-surface-fill); backdrop-filter: var(--dsw-menu-backdrop-filter); pointer-events: none; }
.dmf-backing { display: none; }
html[data-platform="darwin"] .dmf-backing { display: block; position: absolute; inset: 0; z-index: -2; border-radius: inherit; background: var(--dsw-alias-bg-base); pointer-events: none; }
.dmf-material, .dmf-backing { animation: dmf-menu-in 120ms ease-out; }
@keyframes dmf-menu-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dmf-material, .dmf-backing { animation: none; } }
.dmf-status, .dmf-empty { padding: 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dmf-error, .dmf-warning { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; margin-bottom: 3px; padding: 6px 7px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 16px; }
.dmf-warning { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label); }
.dmf-retry { flex: 0 0 auto; padding: 0; border: none; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.dmf-searchRow { position: relative; flex-shrink: 0; margin: 2px 0 3px; }
.dmf-search { box-sizing: border-box; width: 100%; height: auto; padding: 5px 7px; border: 0 solid transparent; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: normal; font-family: inherit; }
.dmf-search:focus { outline: none; }
.dmf-search::placeholder { color: var(--dsw-alias-label-caption); }
.dmf-searchWithQuery { padding-right: 34px; }
@media (pointer: coarse) { .dmf-search { font-size: 16px; } }
.dmf-searchClear { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 50%; corner-shape: round; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dmf-searchClear:focus-visible { outline: none; background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .dmf-searchClear:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dmf-groups:not([hidden]) { min-height: 0; overflow-x: hidden; overflow-y: auto; }
.dmf-option { box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: auto; min-width: 100%; min-height: 34px; padding: 5px 7px; border: none; border-radius: var(--dsw-radius-md); outline: none; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.dmf-option:focus-visible, .dmf-optionActive:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .dmf-option:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } }
.dmf-option:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dmf-folderRow { color: var(--dsw-alias-label-primary); }
.dmf-folderIcon { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.dmf-folderName { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 18px; }
.dmf-folderMeta { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary); }
.dmf-folderCheck { color: var(--dsw-alias-label-primary); }
.dmf-folderCount { min-width: 16px; padding: 0 5px; border-radius: 999px; corner-shape: round; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; text-align: center; }
.dmf-rowChevron { flex: 0 0 auto; color: var(--dsw-alias-menu-icon); }
.dmf-back { box-sizing: border-box; display: flex; align-items: center; gap: 6px; flex-shrink: 0; width: auto; min-width: 100%; height: 30px; margin-bottom: 2px; padding: 0 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; text-align: left; cursor: pointer; outline: none; }
.dmf-back:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .dmf-back:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dmf-backContext { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; text-align: right; }
.dmf-modes { display: flex; flex-shrink: 0; gap: 2px; margin: 2px 0 3px; padding: 2px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); }
.dmf-modeButton { flex: 1 1 0; min-width: 0; height: 24px; padding: 0 6px; border: none; border-radius: calc(var(--dsw-radius-md) - 2px); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; font-family: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.dmf-modeButton[aria-checked="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dmf-modeButton:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
@media (hover: hover) { .dmf-modeButton:hover:not([aria-checked="true"]) { color: var(--dsw-alias-label-primary); } }
.dmf-optionCopy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.dmf-modelName { overflow: hidden; color: inherit; font-size: 13px; line-height: 18px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.dmf-providerCaption { overflow: hidden; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }
.dmf-selected { background: transparent; }
.dmf-check { display: grid; place-items: center; flex: 0 0 14px; color: var(--dsw-alias-label-primary); }
.dmf-check svg { width: 14px; height: 14px; }
.dmf-cell { box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: auto; min-width: 100%; height: 34px; padding: 0 8px; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; cursor: pointer; text-align: left; outline: none; }
.dmf-cell:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
@media (hover: hover) { .dmf-cell:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.dmf-cellLabel { flex: 0 0 auto; white-space: nowrap; }
.dmf-cellValue { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--dsw-alias-label-tertiary); }
.dmf-cellChevron { flex: 0 0 auto; width: 12px; height: 12px; color: var(--dsw-alias-menu-icon); }
.dmf-badgedName { display: inline-flex; align-items: center; max-width: 100%; gap: 4px; vertical-align: baseline; white-space: nowrap; }
.dmf-badgedNameText { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dmf-badge { display: inline-flex; flex: none; align-items: center; border-radius: 999px; corner-shape: round; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; }
.dmf-badge[data-tone="neutral"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.dmf-badge[data-tone="success"] { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }
.dmf-badge[data-tone="info"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent); color: var(--dsw-alias-state-business-primary); }
.dmf-badge[data-tone="warning"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); color: var(--dsw-alias-state-warn-primary); }
.dmf-spinner { box-sizing: border-box; display: inline-block; width: 12px; height: 12px; border: 1.5px solid var(--dsw-alias-label-caption); border-top-color: transparent; border-radius: 50%; animation: dmf-spin 0.8s linear infinite; }
.dmf-triggerSpinner { flex: 0 0 auto; }
@keyframes dmf-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dmf-spinner { animation-duration: 2.4s; } }
.dmf-slGroup {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  display: block;
  user-select: none;
  -webkit-user-select: none;
  padding-top: 2px;
  --dmf-sl-accent: var(--dsw-alias-brand-primary);
  --dmf-sl-fill-1: #9a7cff;
  --dmf-sl-fill-2: #6d3bf5;
  --dmf-sl-fill-3: #4c10dc;
  --dmf-sl-fill-glow: rgba(76, 16, 220, 0.28);
  --dmf-sl-thumb-ring: rgba(124, 92, 255, 0.16);
  --dmf-sl-thumb-glow: rgba(76, 16, 220, 0.35);
}
.dmf-slGroup[data-tone="blue"] {
  --dmf-sl-accent: #2f6bff;
  --dmf-sl-fill-1: #8ec5ff;
  --dmf-sl-fill-2: #3f8bff;
  --dmf-sl-fill-3: #1d54e0;
  --dmf-sl-fill-glow: rgba(29, 84, 224, 0.30);
  --dmf-sl-thumb-ring: rgba(63, 139, 255, 0.18);
  --dmf-sl-thumb-glow: rgba(29, 84, 224, 0.35);
}
.dmf-slCard { box-sizing: border-box; width: 100%; min-width: 208px; padding: 8px 10px 9px; border-radius: 12px; border: 1px solid rgba(24, 12, 60, 0.10); border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.92)); box-shadow: 0 1px 2px rgba(20, 12, 50, 0.05); animation: dmf-sl-in 180ms ease-out; }
@keyframes dmf-sl-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
.dmf-slHead { display: flex; flex-direction: column; align-items: center; gap: 0; margin: 0 0 6px; }
.dmf-slTitles { min-width: 0; max-width: 100%; display: flex; flex-direction: column; align-items: center; gap: 0; }
.dmf-slLevel { display: block; max-width: 100%; overflow: hidden; color: var(--dmf-sl-accent, var(--dsw-alias-brand-primary)); font-size: 13px; line-height: 17px; font-weight: 600; letter-spacing: 0.2px; text-overflow: ellipsis; white-space: nowrap; }
.dmf-slModel { display: block; max-width: 100%; overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 13px; text-overflow: ellipsis; white-space: nowrap; }
.dmf-slTrack { position: relative; box-sizing: border-box; height: 28px; border-radius: 14px; background: rgba(124, 92, 255, 0.12); box-shadow: inset 0 1px 2px rgba(30, 10, 80, 0.14); cursor: grab; outline: none; touch-action: none; }
.dmf-slTrack:focus-visible { box-shadow: inset 0 1px 2px rgba(30, 10, 80, 0.14), 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); }
.dmf-slTrack[aria-disabled="true"] { cursor: default; }
.dmf-slDragging .dmf-slTrack { cursor: grabbing; }
.dmf-slFill { position: absolute; left: 0; top: 0; bottom: 0; width: calc(13px + (100% - 26px) * var(--dmf-sl-pct, 0)); overflow: hidden; border-radius: 14px; background: rgba(109, 59, 245, 0.9); background-image: linear-gradient(90deg, var(--dmf-sl-fill-1, #9a7cff) 0%, var(--dmf-sl-fill-2, #6d3bf5) 55%, var(--dmf-sl-fill-3, #4c10dc) 100%); box-shadow: 0 1px 5px var(--dmf-sl-fill-glow, rgba(76, 16, 220, 0.28)); transition: width 190ms cubic-bezier(0.3, 1.2, 0.4, 1); }
.dmf-slShine { position: absolute; inset: 0; background: linear-gradient(100deg, transparent 25%, rgba(255, 255, 255, 0.30) 45%, transparent 65%); background-size: 220% 100%; background-position: 180% 0; animation: dmf-sl-sweep 3.6s ease-in-out infinite; pointer-events: none; }
@keyframes dmf-sl-sweep { 0% { background-position: 180% 0; } 55%, 100% { background-position: -80% 0; } }
.dmf-slStars { position: absolute; inset: 0; pointer-events: none; }

/* White stars over the filled part; one wide hand-scattered tile per layer. */
.dmf-slStarsA {
  background-repeat: repeat-x;
  background-image:
    radial-gradient(circle at 7% 32%, rgba(255, 255, 255, 0.98) 0 1.3px, rgba(255, 255, 255, 0.35) 1.3px 2.4px, transparent 3px),
    radial-gradient(circle at 13% 70%, rgba(255, 255, 255, 0.90) 0 1.1px, rgba(255, 255, 255, 0.30) 1.1px 2.1px, transparent 2.7px),
    radial-gradient(circle at 21% 22%, rgba(255, 255, 255, 0.98) 0 1.5px, rgba(255, 255, 255, 0.35) 1.5px 2.7px, transparent 3.3px),
    radial-gradient(circle at 29% 56%, rgba(255, 255, 255, 0.85) 0 1px, rgba(255, 255, 255, 0.28) 1px 1.9px, transparent 2.5px),
    radial-gradient(circle at 38% 78%, rgba(255, 255, 255, 0.95) 0 1.2px, rgba(255, 255, 255, 0.32) 1.2px 2.2px, transparent 2.8px),
    radial-gradient(circle at 47% 30%, rgba(255, 255, 255, 0.98) 0 1.4px, rgba(255, 255, 255, 0.35) 1.4px 2.6px, transparent 3.2px),
    radial-gradient(circle at 56% 62%, rgba(255, 255, 255, 0.88) 0 1.1px, rgba(255, 255, 255, 0.30) 1.1px 2px, transparent 2.6px),
    radial-gradient(circle at 64% 18%, rgba(255, 255, 255, 0.98) 0 1.6px, rgba(255, 255, 255, 0.35) 1.6px 2.8px, transparent 3.4px),
    radial-gradient(circle at 73% 48%, rgba(255, 255, 255, 0.82) 0 1px, rgba(255, 255, 255, 0.26) 1px 1.8px, transparent 2.4px),
    radial-gradient(circle at 81% 72%, rgba(255, 255, 255, 0.95) 0 1.2px, rgba(255, 255, 255, 0.32) 1.2px 2.3px, transparent 2.9px),
    radial-gradient(circle at 88% 28%, rgba(255, 255, 255, 0.90) 0 1.1px, rgba(255, 255, 255, 0.30) 1.1px 2px, transparent 2.6px),
    radial-gradient(circle at 95% 58%, rgba(255, 255, 255, 0.98) 0 1.4px, rgba(255, 255, 255, 0.35) 1.4px 2.5px, transparent 3.1px);
  background-size: 320px 28px;
  background-position: 0 0;
  animation: dmf-sl-drift-a 8s linear infinite, dmf-sl-twinkle 2.8s ease-in-out infinite;
}
@keyframes dmf-sl-drift-a { from { background-position: 0 0; } to { background-position: 320px 0; } }
.dmf-slStarsB {
  background-repeat: repeat-x;
  background-image:
    radial-gradient(circle at 11% 55%, rgba(214, 232, 255, 0.95) 0 1.1px, rgba(214, 232, 255, 0.28) 1.1px 2px, transparent 2.6px),
    radial-gradient(circle at 24% 24%, rgba(255, 255, 255, 0.92) 0 1.2px, rgba(255, 255, 255, 0.30) 1.2px 2.1px, transparent 2.7px),
    radial-gradient(circle at 33% 74%, rgba(214, 232, 255, 0.85) 0 1px, rgba(214, 232, 255, 0.24) 1px 1.8px, transparent 2.4px),
    radial-gradient(circle at 46% 40%, rgba(255, 255, 255, 0.98) 0 1.3px, rgba(255, 255, 255, 0.32) 1.3px 2.2px, transparent 2.8px),
    radial-gradient(circle at 58% 62%, rgba(214, 232, 255, 0.88) 0 1.1px, rgba(214, 232, 255, 0.26) 1.1px 1.9px, transparent 2.5px),
    radial-gradient(circle at 67% 20%, rgba(255, 255, 255, 0.95) 0 1.4px, rgba(255, 255, 255, 0.32) 1.4px 2.3px, transparent 2.9px),
    radial-gradient(circle at 79% 68%, rgba(214, 232, 255, 0.85) 0 1px, rgba(214, 232, 255, 0.24) 1px 1.8px, transparent 2.4px),
    radial-gradient(circle at 92% 36%, rgba(255, 255, 255, 0.95) 0 1.2px, rgba(255, 255, 255, 0.30) 1.2px 2.1px, transparent 2.7px);
  background-size: 460px 22px;
  background-position: 0 7px;
  animation: dmf-sl-drift-b 11.5s linear infinite, dmf-sl-twinkle 3.6s ease-in-out infinite 0.9s;
}
@keyframes dmf-sl-drift-b { from { background-position: 0 7px; } to { background-position: 460px 7px; } }
@keyframes dmf-sl-twinkle {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 1; }
}
.dmf-slSpark {
  position: absolute;
  color: rgba(255, 255, 255, 0.95);
  font-size: 10px;
  line-height: 1;
  transform: translate(-50%, -50%) scale(0.55);
  text-shadow: 0 0 6px rgba(255, 255, 255, 0.85);
  pointer-events: none;
  animation: dmf-sl-pop 2.4s ease-in-out infinite;
}
.dmf-slSpark:nth-of-type(1) { animation-delay: 0s; }
.dmf-slSpark:nth-of-type(2) { animation-delay: 0.4s; }
.dmf-slSpark:nth-of-type(3) { animation-delay: 0.8s; }
.dmf-slSpark:nth-of-type(4) { animation-delay: 1.2s; }
.dmf-slSpark:nth-of-type(5) { animation-delay: 1.6s; }
.dmf-slSpark:nth-of-type(6) { animation-delay: 2s; }
@keyframes dmf-sl-pop {
  0%, 100% { opacity: 0.2; transform: translate(-50%, -50%) scale(0.55) rotate(0deg); }
  50% { opacity: 1; transform: translate(-50%, -50%) scale(1.3) rotate(45deg); }
}
.dmf-slThumb { position: absolute; top: 1px; left: calc(13px + (100% - 26px) * var(--dmf-sl-pct, 0)); width: 26px; height: 26px; margin-left: -13px; border-radius: 50%; background: #ffffff; box-shadow: 0 2px 5px rgba(20, 10, 50, 0.26), 0 0 0 1px var(--dmf-sl-thumb-ring, rgba(124, 92, 255, 0.16)); pointer-events: none; transition: left 190ms cubic-bezier(0.3, 1.2, 0.4, 1), transform 140ms ease, box-shadow 140ms ease; }
.dmf-slDragging .dmf-slFill { transition: none; }
.dmf-slDragging .dmf-slThumb { transform: scale(1.08); box-shadow: 0 3px 10px var(--dmf-sl-thumb-glow, rgba(76, 16, 220, 0.35)), 0 0 0 1px var(--dmf-sl-thumb-ring, rgba(124, 92, 255, 0.16)); }
.dmf-slBusy { opacity: 0.75; }
.dmf-slHint { margin: 5px 0 0; overflow: hidden; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 13px; letter-spacing: 0.2px; text-align: center; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
.dmf-slSr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; border: 0; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .dmf-slCard, .dmf-slShine, .dmf-slStarsA, .dmf-slStarsB, .dmf-slSpark { animation: none; }
  .dmf-slFill, .dmf-slThumb { transition: none; }
}
`

    /* ------------------------------------------------------------------ *
     * The picker
     * ------------------------------------------------------------------ */

    const PANE_ROOT = 'root'
    const PANE_FOLDERS = 'folders'
    const PANE_FOLDER = 'folder'
    const PANE_EFFORT = 'effort'

    /**
     * Whether the primary pointer is coarse (phones/tablets); those devices do
     * not steal focus into the search field.
     * @returns {boolean}
     */
    function isCoarsePointer() {
      return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
    }

    /**
     * Join truthy class names.
     * @param {...(string | false | null | undefined)} names - candidate classes.
     * @returns {string}
     */
    function cls(...names) {
      return names.filter(Boolean).join(' ')
    }

    /**
     * Interpolate `{name}` placeholders in one dictionary template.
     * @param {string} template - dictionary text.
     * @param {Record<string, unknown> | undefined} params - values.
     * @returns {string}
     */
    function format(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = params[key]
        return value === undefined ? match : String(value)
      })
    }

    /**
     * Last-resort translate seat: keeps the picker readable if the host's
     * locale seat is unavailable (the renderer always supplies one).
     * @param {string} key - dictionary key.
     * @param {Record<string, unknown>} [params] - interpolation values.
     * @returns {string}
     */
    function fallbackTranslate(key, params) {
      return format(zh[key] ?? en[key] ?? key, params)
    }

    /**
     * The composer model seat: a folder-first picker over the shared directory.
     * @param {object} props - owner `locked`, injected directory face, `t` seat.
     * @returns {React.ReactElement | null}
     */
    function ModelFoldersSelect(props) {
      const { locked, available, directory } = props
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      const load = typeof props.load === 'function' ? props.load : () => {}
      const resolveText = typeof props.resolveText === 'function'
        ? props.resolveText
        : (text) => (typeof text === 'string' ? text : text?.en ?? text?.zh ?? '')
      const select = typeof props.select === 'function' ? props.select : () => Promise.resolve(undefined)

      const subscribeDirectory = React.useCallback((listener) => directory.subscribe(listener), [directory])
      const readDirectory = React.useCallback(() => directory.getSnapshot(), [directory])
      const state = React.useSyncExternalStore(subscribeDirectory, readDirectory)
      const mode = React.useSyncExternalStore(subscribeMode, getMode)

      const [open, setOpen] = React.useState(false)
      const [pane, setPane] = React.useState(PANE_ROOT)
      const [unitId, setUnitId] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [highlighted, setHighlighted] = React.useState(null)
      const [selectionFocus, setSelectionFocus] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [sliderPreview, setSliderPreview] = React.useState(null)
      const [sliderHover, setSliderHover] = React.useState(null)
      const [sliderDragging, setSliderDragging] = React.useState(false)
      const [sliderAnnouncement, setSliderAnnouncement] = React.useState('')
      const sliderTrackRef = React.useRef(null)
      const sliderDraggingRef = React.useRef(false)

      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const searchRef = React.useRef(null)
      const modeButtonRefs = React.useRef({})
      const focusIntent = React.useRef(null)
      const returnCell = React.useRef('model')
      const lastUnit = React.useRef(null)
      const lastAction = React.useRef('load')
      const reactId = React.useId()
      const listId = `${reactId}-models`
      const anchorStyle = { '--dmf-anchor': `--dmf-${reactId.replaceAll(':', '')}` }

      const groups = React.useMemo(() => orderProviders(state.groups), [state.groups])
      const units = React.useMemo(() => buildUnits(mode, groups, t), [mode, groups, t])
      const entries = React.useMemo(() => units.flatMap((unit) => unit.entries), [units])

      const current = state.current
      const currentEntry = React.useMemo(() => current === null
        ? undefined
        : entries.find((entry) => entry.group.id === current.provider && entry.model.id === current.model), [entries, current])

      const reasoning = currentEntry === undefined ? undefined : currentEntry.model.reasoning
      const effectiveEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = current === null
        ? undefined
        : currentEntry === undefined || reasoning === undefined
          ? state.retainedEffort
          : effectiveEffort === undefined
            ? t('effort.providerDefault')
            : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort

      const effortChoices = React.useMemo(() => reasoning === undefined
        ? []
        : [
          ...(reasoning.defaultEffort === undefined
            ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
            : []),
          ...reasoning.efforts.map((level) => ({ key: `effort:${level.id}`, effort: level.id, label: level.name })),
        ], [reasoning, t])

      const sliderLevels = React.useMemo(() => {
        if (reasoning === undefined) return []
        const list = []
        if (reasoning.defaultEffort === undefined) {
          list.push({ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') })
        }
        for (const level of reasoning.efforts) list.push({ key: `effort:${level.id}`, effort: level.id, label: level.name })
        return list
      }, [reasoning, t])

      let sliderIndex = sliderLevels.findIndex((level) => level.effort === effectiveEffort)
      if (sliderIndex < 0 && reasoning !== undefined) {
        sliderIndex = sliderLevels.findIndex((level) => level.effort === reasoning.defaultEffort)
      }
      if (sliderIndex < 0) sliderIndex = 0
      const sliderShown = sliderPreview === null
        ? sliderIndex
        : Math.max(0, Math.min(sliderLevels.length - 1, sliderPreview))
      const sliderPercent = sliderLevels.length < 2 ? 0 : sliderShown / (sliderLevels.length - 1)

      const trimmedQuery = query.trim()
      const isSearching = trimmedQuery !== ''
      const results = React.useMemo(() => isSearching ? rankEntries(entries, trimmedQuery) : [], [entries, isSearching, trimmedQuery])
      const showSearch = entries.length > 4

      const listCount = isSearching ? results.length : units.length
      const defaultIndex = (() => {
        if (current === null) return 0
        if (isSearching) {
          return results.findIndex((entry) => entry.group.id === current.provider && entry.model.id === current.model)
        }
        return units.findIndex((unit) => unit.entries.some((entry) => entry.group.id === current.provider && entry.model.id === current.model))
      })()
      const activeIndex = listCount === 0 ? -1 : Math.min(highlighted ?? Math.max(0, defaultIndex), listCount - 1)

      const pending = state.pending
      const busy = pending !== null
      const waiting = currentEntry === undefined && state.status === 'loading'
      const modelLabel = waiting
        ? t('trigger.loading')
        : currentEntry?.model.name ?? t('trigger.fallback')
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      const triggerAria = waiting
        ? t('trigger.loading')
        : currentEntry === undefined
          ? t('trigger.selectAria')
          : effortLabel === undefined
            ? t('trigger.aria', { model: modelLabel })
            : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })

      const unit = unitId === null ? null : units.find((candidate) => candidate.id === unitId) ?? null
      const activePane = pane === PANE_FOLDER && unit === null ? PANE_FOLDERS : pane

      /* ------------------------------ verbs ------------------------------ */

      const reload = () => {
        lastAction.current = 'load'
        setFailure(null)
        load()
      }

      const show = () => {
        setSelectionFocus(false)
        triggerRef.current?.focus()
        setQuery('')
        setHighlighted(null)
        setFailure(null)
        lastAction.current = 'load'
        setOpen(true)
        if (currentEntry === undefined) {
          setPane(PANE_FOLDERS)
          focusIntent.current = showSearch && !isCoarsePointer() ? 'search' : 'rows'
        } else {
          setPane(PANE_ROOT)
          focusIntent.current = null
        }
        load()
      }

      const close = (restoreFocus = false) => {
        setOpen(false)
        setPane(PANE_ROOT)
        setUnitId(null)
        setQuery('')
        setHighlighted(null)
        setFailure(null)
        if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
      }

      const closeAfterSelection = () => {
        setSelectionFocus(true)
        close(true)
      }

      const drill = (next) => {
        setPane(next)
        setQuery('')
        setHighlighted(null)
        setFailure(null)
        if (next === PANE_EFFORT) returnCell.current = 'effort'
        else if (next === PANE_FOLDERS) returnCell.current = 'model'
        focusIntent.current = next === PANE_FOLDERS && showSearch && !isCoarsePointer() ? 'search' : 'rows'
      }

      const openUnit = (nextUnit) => {
        lastUnit.current = nextUnit.id
        setUnitId(nextUnit.id)
        setPane(PANE_FOLDER)
        setQuery('')
        setHighlighted(null)
        setFailure(null)
        focusIntent.current = 'rows'
      }

      const back = () => {
        setFailure(null)
        setQuery('')
        setHighlighted(null)
        if (activePane === PANE_FOLDER) {
          setPane(PANE_FOLDERS)
          focusIntent.current = lastUnit.current === null ? 'rows' : { unit: lastUnit.current }
          return
        }
        setPane(PANE_ROOT)
        focusIntent.current = { cell: returnCell.current }
      }

      const changeMode = (next) => {
        setMode(next)
        setHighlighted(null)
        setFailure(null)
      }

      const settleSelection = (result) => {
        if (result === undefined) return
        if (result.ok) {
          if (rootRef.current !== null) closeAfterSelection()
          return
        }
        const { error } = result
        setFailure(error.code === 'session/writer-held'
          ? t('error.sessionInUse')
          : t('error.action', { message: `${error.code}: ${error.message}` }))
      }

      const submit = (selection) => {
        lastAction.current = 'select'
        setSelectionFocus(true)
        setFailure(null)
        triggerRef.current?.focus()
        let operation
        try {
          operation = select(selection)
        } catch (error) {
          setFailure(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
          return
        }
        Promise.resolve(operation).then(settleSelection)
      }

      const chooseModel = (entry) => {
        if (current !== null && current.provider === entry.group.id && current.model === entry.model.id) {
          closeAfterSelection()
          return
        }
        submit({ provider: entry.group.id, model: entry.model.id })
      }

      const chooseEffort = (effort) => {
        if (current === null) return
        if (effectiveEffort === effort) {
          closeAfterSelection()
          return
        }
        submit({
          provider: current.provider,
          model: current.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        })
      }

      /* --------------------------- effort slider --------------------------- */

      const sliderIndexFromPoint = (clientX) => {
        const node = sliderTrackRef.current
        if (node === null || sliderLevels.length < 2) return 0
        const rect = node.getBoundingClientRect()
        const usable = Math.max(1, rect.width - 22)
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left - 11) / usable))
        return Math.round(ratio * (sliderLevels.length - 1))
      }

      const sliderCommit = (effort, name) => {
        if (current === null || locked === true || busy) {
          setSliderPreview(null)
          return
        }
        if (effort === effectiveEffort) {
          setSliderPreview(null)
          if (name !== undefined) setSliderAnnouncement(t('effort.sliderAnnounce', { name }))
          return
        }
        const selection = {
          provider: current.provider,
          model: current.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        }
        Promise.resolve(select(selection)).then((result) => {
          setSliderPreview(null)
          if (result !== undefined && result.ok === false) {
            setFailure(t('error.action', { message: `${result.error.code}: ${result.error.message}` }))
            return
          }
          if (name !== undefined) setSliderAnnouncement(t('effort.sliderAnnounce', { name }))
        }).catch((error) => {
          setSliderPreview(null)
          setFailure(t('error.action', { message: error instanceof Error ? error.message : String(error) }))
        })
      }

      const renderEffortSlider = () => {
        if (reasoning === undefined || sliderLevels.length < 2) return null
        const disabled = locked === true || busy
        const level = sliderLevels[sliderShown]
        const levelName = level === undefined ? '' : level.label
        const modelName = currentEntry === undefined ? '' : currentEntry.model.name
        // The two lowest efforts read as blue; everything above stays violet.
        const tone = level !== undefined && (level.effort === 'off' || level.effort === 'low') ? 'blue' : 'violet'
        const hint = busy && level !== undefined
          ? t('effort.sliderPending', { name: levelName })
          : t('effort.sliderHint')
        const pointerIndex = (event) => sliderIndexFromPoint(event.clientX)
        const onPointerDown = (event) => {
          if (disabled) return
          event.preventDefault()
          const node = event.currentTarget
          try { node.setPointerCapture(event.pointerId) } catch (ignored) { /* older engines */ }
          sliderDraggingRef.current = true
          setSliderDragging(true)
          if (typeof node.focus === 'function') node.focus({ preventScroll: true })
          const next = pointerIndex(event)
          setSliderPreview(next)
          setSliderHover(next)
        }
        const onPointerMove = (event) => {
          if (!sliderDraggingRef.current || event.buttons === 0) return
          const next = pointerIndex(event)
          setSliderPreview(next)
          setSliderHover(next)
        }
        const onPointerUp = (event) => {
          if (!sliderDraggingRef.current) return
          sliderDraggingRef.current = false
          setSliderDragging(false)
          try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (ignored) { /* already released */ }
          const next = pointerIndex(event)
          setSliderHover(null)
          if (sliderLevels[next] === undefined) {
            setSliderPreview(null)
            return
          }
          setSliderPreview(next)
          sliderCommit(sliderLevels[next].effort, sliderLevels[next].label)
        }
        const onPointerCancel = () => {
          sliderDraggingRef.current = false
          setSliderDragging(false)
          setSliderPreview(null)
          setSliderHover(null)
        }
        const onLostPointerCapture = () => {
          if (!sliderDraggingRef.current) return
          onPointerCancel()
        }
        const onKeyDown = (event) => {
          if (disabled || event.nativeEvent.isComposing) return
          const active = sliderPreview === null ? sliderIndex : sliderPreview
          let next = active
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(sliderLevels.length - 1, active + 1)
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, active - 1)
          else if (event.key === 'Home') next = 0
          else if (event.key === 'End') next = sliderLevels.length - 1
          else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            if (sliderLevels[active] !== undefined) {
              setSliderPreview(active)
              setSliderHover(active)
              sliderCommit(sliderLevels[active].effort, sliderLevels[active].label)
            }
            return
          } else {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          if (sliderLevels[next] === undefined) return
          setSliderPreview(next)
          setSliderHover(next)
          sliderCommit(sliderLevels[next].effort, sliderLevels[next].label)
        }
        return h('div', {
          key: 'effort-slider',
          className: cls('dmf-slGroup', sliderDragging && 'dmf-slDragging', busy && 'dmf-slBusy'),
          'data-tone': tone,
        },
          h('div', { className: 'dmf-slCard', role: 'group', 'aria-label': t('menu.effort') },
            h('div', { className: 'dmf-slHead' },
              h('div', { className: 'dmf-slTitles' },
                h('span', { className: 'dmf-slLevel', title: levelName }, levelName),
                modelName === '' ? null : h('span', { className: 'dmf-slModel', title: modelName }, modelName))),
            h('span', { className: 'dmf-slSr', 'aria-live': 'polite' }, sliderAnnouncement),
            h('div', {
              ref: sliderTrackRef,
              className: 'dmf-slTrack',
              role: 'slider',
              tabIndex: 0,
              'aria-label': t('menu.effort'),
              'aria-orientation': 'horizontal',
              'aria-valuemin': 0,
              'aria-valuemax': sliderLevels.length - 1,
              'aria-valuenow': sliderShown,
              'aria-valuetext': levelName,
              'aria-disabled': disabled ? 'true' : undefined,
              title: t('effort.sliderAria', { name: levelName }),
              'data-effort': level === undefined ? undefined : (level.effort === undefined ? 'default' : String(level.effort)),
              style: { '--dmf-sl-pct': String(sliderPercent) },
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel,
              onLostPointerCapture,
              onKeyDown,
              onFocus: () => { if (!disabled) setSliderHover(sliderShown) },
              onBlur: () => { setSliderHover(null) },
            },
              h('div', { className: 'dmf-slFill', 'aria-hidden': true },
                h('div', { className: 'dmf-slStars dmf-slStarsA' }),
                h('div', { className: 'dmf-slStars dmf-slStarsB' }),
                h('span', { className: 'dmf-slSpark', style: { left: '14%', top: '38%' } }, '✦'),
                h('span', { className: 'dmf-slSpark', style: { left: '26%', top: '64%' } }, '✦'),
                h('span', { className: 'dmf-slSpark', style: { left: '34%', top: '30%' } }, '✦'),
                h('span', { className: 'dmf-slSpark', style: { left: '58%', top: '26%' } }, '✦'),
                h('span', { className: 'dmf-slSpark', style: { left: '70%', top: '62%' } }, '✦'),
                h('span', { className: 'dmf-slSpark', style: { left: '84%', top: '40%' } }, '✦'),
                h('div', { className: 'dmf-slShine' })),
              h('div', { className: 'dmf-slThumb', 'aria-hidden': true }),
            ),
            h('div', { className: 'dmf-slHint', 'aria-hidden': true }, hint)))
      }

      /* ---------------------------- keyboard ---------------------------- */

      /** Menu rows for arrow-key traversal; the grouping switch is not a row. */
      const menuRows = () => {
        const menu = menuRef.current
        if (menu === null) return []
        return Array.from(menu.querySelectorAll(
          'button[role="menuitem"]:not([disabled]), button[role="menuitemradio"]:not([disabled])',
        )).filter((item) => !(item instanceof HTMLElement) || item.dataset.switch === undefined)
      }

      /** The checked item row (never the grouping switch). */
      const checkedRow = () => menuRef.current?.querySelector(
        '.dmf-groups button[role="menuitemradio"][aria-checked="true"]:not([disabled])',
      )

      const moveFocus = (offset) => {
        const items = menuRows()
        if (items.length === 0) return
        const active = items.findIndex((item) => item === document.activeElement)
        const next = active === -1
          ? (offset > 0 ? 0 : items.length - 1)
          : (active + offset + items.length) % items.length
        items[next]?.focus()
      }

      /** Focus one grouping-switch button by mode. */
      const focusModeButton = (target) => {
        const button = modeButtonRefs.current[target]
        if (button instanceof HTMLElement) button.focus()
      }

      const activateHighlighted = () => {
        if (activePane !== PANE_FOLDERS) return
        if (isSearching) {
          const entry = results[activeIndex]
          if (entry !== undefined) chooseModel(entry)
          return
        }
        const nextUnit = units[activeIndex]
        if (nextUnit !== undefined) openUnit(nextUnit)
      }

      const onKeyDown = (event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          if (activePane !== PANE_ROOT) back()
          else close(true)
          return
        }
        if (!open) return
        if (event.key === 'Tab') {
          if (event.shiftKey) {
            event.preventDefault()
            if (activePane !== PANE_ROOT) back()
            else close(true)
            return
          }
          const focused = document.activeElement
          if (focused instanceof HTMLElement && focused.dataset.switch !== undefined) return
          const rows = menuRows()
          if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
            event.preventDefault()
            focused.click()
            return
          }
          if (focused !== triggerRef.current) return
          event.preventDefault()
          if (activePane === PANE_FOLDERS) {
            // The grouping switch is the first stop of the folder pane, so a
            // keyboard user reaches the headline toggle before search.
            focusModeButton(mode)
            return
          }
          const checked = checkedRow()
          const target = checked ?? rows.find((item) => item.dataset.row === '1')
          ;(target ?? triggerRef.current)?.focus()
          return
        }
        const focusedNow = document.activeElement
        if (focusedNow instanceof HTMLElement && focusedNow.dataset.switch !== undefined
          && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault()
          const next = mode === 'provider' ? 'family' : 'provider'
          changeMode(next)
          queueMicrotask(() => { focusModeButton(next) })
          return
        }
        if (activePane === PANE_FOLDERS && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          if (busy || listCount === 0) return
          const direction = event.key === 'ArrowDown' ? 1 : -1
          setHighlighted(((activeIndex + direction) % listCount + listCount) % listCount)
          if (document.activeElement !== searchRef.current) searchRef.current?.focus()
          return
        }
        if (activePane === PANE_FOLDERS && showSearch && event.target instanceof HTMLInputElement
          && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
          if (event.key === 'Tab' && listCount === 0) return
          event.preventDefault()
          if (!busy) activateHighlighted()
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }

      const onBlur = (event) => {
        if (event.relatedTarget instanceof Node && (
          rootRef.current?.contains(event.relatedTarget) === true
          || menuRef.current?.contains(event.relatedTarget) === true
        )) return
        close()
      }

      /* ----------------------------- effects ----------------------------- */

      React.useEffect(() => {
        if (!open) return
        const closeOutside = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (menuRef.current?.contains(event.target) === true) return
          close()
        }
        document.addEventListener('mousedown', closeOutside)
        return () => { document.removeEventListener('mousedown', closeOutside) }
      }, [open])

      React.useEffect(() => {
        if (!open) return
        const intent = focusIntent.current
        focusIntent.current = null
        if (intent === null) return
        if (intent === 'search') {
          searchRef.current?.focus()
          return
        }
        const menu = menuRef.current
        if (menu === null) return
        if (intent === 'rows') {
          const checked = checkedRow()
          const first = menu.querySelector('button[data-row="1"]:not([disabled])')
          ;(checked ?? first ?? triggerRef.current)?.focus()
          return
        }
        if (intent.cell !== undefined) {
          const cell = menu.querySelector(`button[data-cell="${intent.cell}"]`)
          ;(cell ?? triggerRef.current)?.focus()
          return
        }
        if (intent.unit !== undefined) {
          const row = Array.from(menu.querySelectorAll('button[data-unit]'))
            .find((candidate) => candidate instanceof HTMLElement && candidate.dataset.unit === intent.unit)
          ;(row ?? triggerRef.current)?.focus()
        }
      }, [open, activePane, unitId, mode])

      React.useLayoutEffect(() => {
        if (!open || activePane !== PANE_FOLDERS || activeIndex < 0) return
        const row = document.getElementById(`${reactId}-row-${activeIndex}`)
        row?.scrollIntoView({ block: 'nearest' })
      }, [open, activePane, activeIndex, isSearching])

      /* ----------------------------- rendering ----------------------------- */

      if (!available) return null

      const errorStrip = (message) => message === null
        ? null
        : h('div', { key: 'failure', className: 'dmf-error', role: 'status' }, h('span', null, message))

      const loadStrip = () => state.error !== null && lastAction.current === 'load'
        ? h('div', { key: 'load-error', className: 'dmf-error' },
          h('span', null, t('error.action', { message: state.error })),
          h('button', { type: 'button', className: 'dmf-retry', onClick: reload }, t('action.reload')))
        : null

      const warnings = () => state.failures.map((warning) => h('div', { className: 'dmf-warning', key: warning.id },
        h('span', null, t('warning.groupLoad', {
          name: warning.id === 'deepseek-account' ? t('provider.account') : warning.name,
          message: warning.message,
        })),
        h('button', { type: 'button', className: 'dmf-retry', onClick: reload }, t('action.reload'))))

      const modelLabelNode = (model, placement) => {
        const text = model.name
        if (model.badge === undefined) return text
        const badge = h('span', { className: 'dmf-badge', 'data-tone': model.badge.tone }, resolveText(model.badge.text))
        const name = h('span', { className: 'dmf-badgedNameText' }, text)
        return h('span', { className: 'dmf-badgedName' },
          ...(placement === 'trigger' ? [badge, ' ', name] : [name, ' ', badge]))
      }

      const cell = (key, label, value, onClick) => h('button', {
        key, type: 'button', role: 'menuitem', 'data-row': '1', 'data-cell': key, className: 'dmf-cell', onClick,
      },
        h('span', { className: 'dmf-cellLabel' }, label),
        h('span', { className: 'dmf-cellValue' }, value),
        ChevronRightIcon({ className: 'dmf-cellChevron' }))

      const folderRow = (candidate, index, searchMode) => {
        const hasCurrent = current !== null && candidate.entries.some((entry) =>
          entry.group.id === current.provider && entry.model.id === current.model)
        const highlightedHere = searchMode && index === activeIndex
        return h('button', {
          key: candidate.id,
          type: 'button',
          role: 'menuitem',
          id: `${reactId}-row-${index}`,
          'data-row': '1',
          'data-unit': candidate.id,
          tabIndex: searchMode ? -1 : 0,
          'data-highlighted': highlightedHere ? '' : undefined,
          className: cls('dmf-option', 'dmf-folderRow', highlightedHere && 'dmf-optionActive'),
          title: candidate.label,
          disabled: busy,
          onFocus: () => { if (searchMode) setHighlighted(index) },
          onMouseMove: busy || !searchMode || highlightedHere ? undefined : () => { setHighlighted(index) },
          onClick: () => { openUnit(candidate) },
        },
          h('span', { className: 'dmf-folderIcon' }, FolderIcon({})),
          h('span', { className: 'dmf-folderName' }, candidate.label),
          h('span', { className: 'dmf-folderMeta' },
            hasCurrent ? CheckIcon({ className: 'dmf-folderCheck' }) : null,
            h('span', { className: 'dmf-folderCount' }, String(candidate.entries.length))),
          ChevronRightIcon({ className: 'dmf-rowChevron' }))
      }

      const modelRow = (entry, index, options) => {
        const selected = current !== null && current.provider === entry.group.id && current.model === entry.model.id
        const pendingHere = pending !== null && pending.provider === entry.group.id && pending.model === entry.model.id
        const highlightedHere = options.searchMode && index === activeIndex
        return h('button', {
          key: `${entry.group.id}/${entry.model.id}`,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': selected,
          id: `${reactId}-row-${index}`,
          tabIndex: options.searchMode ? -1 : 0,
          'data-highlighted': highlightedHere ? '' : undefined,
          className: cls('dmf-option', 'dmf-modelOption', selected && 'dmf-selected', highlightedHere && 'dmf-optionActive'),
          title: entry.model.name,
          disabled: busy,
          onFocus: () => { if (options.searchMode) setHighlighted(index) },
          onMouseMove: busy || !options.searchMode || highlightedHere ? undefined : () => { setHighlighted(index) },
          onClick: () => { chooseModel(entry) },
        },
          h('span', { className: 'dmf-optionCopy' },
            h('span', { className: 'dmf-modelName' }, modelLabelNode(entry.model, 'option')),
            options.withProvider ? h('span', { className: 'dmf-providerCaption' }, entry.provider.name) : null),
          h('span', { className: 'dmf-check' },
            pendingHere ? SpinnerIcon({}) : selected ? CheckIcon({}) : null))
      }

      const searchRow = () => h('div', { key: 'search', className: 'dmf-searchRow' },
        h('input', {
          ref: searchRef,
          className: cls('dmf-search', query !== '' && 'dmf-searchWithQuery'),
          type: 'text',
          role: 'searchbox',
          'aria-label': t('search.placeholder'),
          'aria-controls': listId,
          'aria-activedescendant': activeIndex >= 0 ? `${reactId}-row-${activeIndex}` : undefined,
          placeholder: t('search.placeholder'),
          value: query,
          readOnly: busy,
          onChange: (event) => {
            const next = event.target.value
            setQuery(next)
            setHighlighted(next.trim() === '' ? null : 0)
          },
        }),
        query !== '' ? h('button', {
          type: 'button',
          className: 'dmf-searchClear',
          'aria-label': t('search.clear'),
          disabled: busy,
          onClick: () => {
            setQuery('')
            setHighlighted(null)
            searchRef.current?.focus()
          },
        }, CloseIcon({})) : null)

      const backRow = (context) => h('button', {
        key: 'back', type: 'button', tabIndex: -1, className: 'dmf-back', onClick: back,
      },
        ChevronLeftIcon({}),
        h('span', null, t('back')),
        h('span', { className: 'dmf-backContext' }, context))

      const modeSwitch = () => h('div', {
        key: 'modes', className: 'dmf-modes', role: 'radiogroup', 'aria-label': t('menu.grouping'),
      },
        ...[['provider', t('mode.provider'), t('mode.providerHint')], ['family', t('mode.family'), t('mode.familyHint')]]
          .map(([id, label, hint]) => h('button', {
            key: id,
            ref: (node) => { modeButtonRefs.current[id] = node },
            type: 'button',
            role: 'radio',
            'aria-checked': mode === id,
            'data-switch': '1',
            tabIndex: mode === id ? 0 : -1,
            className: 'dmf-modeButton',
            title: hint,
            onClick: () => { changeMode(id) },
          }, label)))

      const lists = []
      if (activePane === PANE_ROOT) {
        lists.push(errorStrip(failure))
        // A fault in the optional slider row must not take the whole picker
        // down: the seat is a single slot, so a render throw would hand the
        // composer back to the shipped selector.
        let sliderRow = null
        try {
          sliderRow = renderEffortSlider()
        } catch (error) {
          sliderRow = null
        }
        lists.push(cell('model', t('menu.model'),
          currentEntry === undefined ? modelLabel : modelLabelNode(currentEntry.model, 'menu'),
          () => { drill(PANE_FOLDERS) }))
        // The slider is the effort control now; the discrete row stays only for
        // models that expose no draggable levels.
        lists.push(reasoning !== undefined && sliderRow === null
          ? cell('effort', t('menu.effort'),
            effortLabel ?? t('effort.providerDefault'),
            () => { drill(PANE_EFFORT) })
          : null)
        lists.push(sliderRow)
      } else if (activePane === PANE_FOLDERS) {
        lists.push(errorStrip(failure))
        lists.push(backRow(t('menu.model')))
        lists.push(modeSwitch())
        lists.push(showSearch ? searchRow() : null)
        lists.push(state.status === 'loading' ? h('div', { key: 'status', className: 'dmf-status' }, t('status.loading')) : null)
        lists.push(loadStrip())
        lists.push(...warnings())
        lists.push(h('div', {
          key: 'list',
          id: listId,
          className: 'dmf-groups scrollable',
          role: 'menu',
          'aria-label': isSearching ? t('search.placeholder') : t('menu.model'),
          hidden: listCount === 0,
        },
          isSearching
            ? results.map((entry, index) => modelRow(entry, index, { searchMode: true, withProvider: true }))
            : units.map((candidate, index) => folderRow(candidate, index, showSearch))))
        if (state.status === 'ready' && listCount === 0) {
          lists.push(h('div', { key: 'empty', className: 'dmf-empty', role: 'status' },
            entries.length === 0 ? t('empty.models') : t('search.empty')))
        }
      } else if (activePane === PANE_FOLDER) {
        lists.push(errorStrip(failure))
        lists.push(backRow(unit.label))
        lists.push(h('div', { key: 'models', className: 'dmf-groups scrollable', role: 'menu', 'aria-label': unit.label },
          unit.entries.length === 0
            ? h('div', { className: 'dmf-empty' }, t('empty.models'))
            : unit.entries.map((entry, index) => modelRow(entry, index, {
              searchMode: false,
              withProvider: mode === 'family',
            }))))
      } else if (activePane === PANE_EFFORT) {
        lists.push(errorStrip(failure))
        lists.push(backRow(t('menu.effort')))
        const effortRows = effortChoices.map((level) => {
          const selected = effectiveEffort === level.effort
          const pendingHere = pending !== null && current !== null
            && pending.provider === current.provider
            && pending.model === current.model
            && pending.reasoningEffort === level.effort
          return h('button', {
            key: level.key,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            className: cls('dmf-option', selected && 'dmf-selected'),
            disabled: busy,
            onClick: () => { chooseEffort(level.effort) },
          },
            h('span', { className: 'dmf-optionCopy' },
              h('span', { className: 'dmf-modelName' }, level.label)),
            h('span', { className: 'dmf-check' },
              pendingHere ? SpinnerIcon({}) : selected ? CheckIcon({}) : null))
        })
        lists.push(h('div', { key: 'efforts', className: 'dmf-groups scrollable', role: 'menu', 'aria-label': t('menu.effort') },
          effortChoices.length === 0
            ? h('div', { className: 'dmf-empty' }, t('empty.efforts'))
            : effortRows))
      }

      const menuLabel = activePane === PANE_FOLDERS
        ? t('menu.model')
        : activePane === PANE_FOLDER
          ? unit.label
          : activePane === PANE_EFFORT ? t('menu.effort') : t('menu.aria')

      const menu = open ? h('div', {
        ref: menuRef,
        id: `${reactId}-menu`,
        className: 'dmf-menu',
        style: anchorStyle,
        role: activePane === PANE_ROOT ? 'menu' : 'group',
        'aria-label': menuLabel,
        'aria-busy': state.status === 'loading' || busy ? true : undefined,
      },
        h('div', { className: 'dmf-backing', 'aria-hidden': true }),
        h('div', { className: 'dmf-material', 'aria-hidden': true }),
        lists) : null

      return h('div', {
        ref: rootRef,
        className: 'dmf-root',
        onKeyDown,
        onBlur,
        onMouseDown: (event) => {
          if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
        },
      },
        h('style', null, CSS),
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dmf-trigger',
          style: anchorStyle,
          'aria-label': triggerAria,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-controls': open ? `${reactId}-menu` : undefined,
          title: triggerLabel,
          'aria-busy': busy ? true : undefined,
          'data-selection-focus': selectionFocus ? '' : undefined,
          disabled: locked,
          onBlur: () => { setSelectionFocus(false) },
          onClick: () => {
            if (open) close(true)
            else show()
          },
        },
          ModelsIcon({ className: 'dmf-triggerIcon' }),
          h('span', { className: 'dmf-triggerLabel' },
            currentEntry === undefined ? modelLabel : modelLabelNode(currentEntry.model, 'trigger')),
          effortLabel === undefined ? null : h('span', { className: 'dmf-triggerEffort' }, effortLabel),
          busy
            ? SpinnerIcon({ className: 'dmf-triggerSpinner' })
            : ChevronDownIcon({ className: cls('dmf-chevron', open && 'dmf-chevronOpen') })),
        menu === null ? null : createPortal(menu, document.body))
    }

    /* ------------------------------------------------------------------ *
     * Client plugin
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'sessions', 'locale', 'modelDirectories']

    /**
     * Register the dictionaries and shadow the composer's model seat.
     * @param {object} ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model-folders: dictionaries')
      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key === MODE_KEY) syncModeFromStorage()
        }
        window.addEventListener('storage', onStorage)
        return () => { window.removeEventListener('storage', onStorage) }
      }, 'model-folders: grouping preference sync')
      ctx.inject(['slots', 'sessions', 'modelDirectories'], (scope) => {
        const models = scope.modelDirectories
        const sessions = scope.sessions
        scope.slots.inject('conversation.input.model', () => scope.slots.register({
          name: 'conversation.input.model',
          // The shipped selector registers the same single slot at priority 0;
          // the registry renders the lowest priority, so -1 shadows it.
          priority: -1,
          locale: NS,
          inject: (sessionId) => {
            const directory = models.directoryFor(sessionId)
            const available = sessions.subagentAddress(sessionId) === undefined
            return {
              available,
              directory: directory.store,
              load: () => {
                if (!available) return
                directory.load().catch(() => { /* surfaced on the store */ })
              },
              resolveText: (text) => ctx.locale.resolveText(text),
              select: (selection) => available ? directory.select(selection) : Promise.resolve(undefined),
            }
          },
        }, ModelFoldersSelect))

      })
    }

    return { inject, apply }
  },
})
