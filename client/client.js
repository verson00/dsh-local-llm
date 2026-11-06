/**
 * dsh-local-llm — client half.
 *
 * The Settings page for the local llama.cpp Qwen3.5-4B server: a status light,
 * start/stop/restart, and the launch parameters. Everything it does goes through
 * the same-origin routes the host half mounts under /local-llm; the page owns no
 * process logic of its own.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-llm',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const CSS = `
.dll-page { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
.dll-desc { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dll-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.dll-card-head { display: flex; align-items: center; gap: 6px; margin: 0; padding: 0; border: none;
  background: none; cursor: pointer; color: var(--dsw-alias-label-primary); font-family: inherit; text-align: left; }
.dll-card-head:hover .dll-card-title { color: var(--dsw-alias-brand-primary); }
.dll-caret { font-size: 11px; color: var(--dsw-alias-label-secondary); width: 12px; }
.dll-card-body { display: flex; flex-direction: column; gap: 12px; }
.dll-card-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dll-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dll-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.dll-dot--ready { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent); }
.dll-dot--starting { background: var(--dsw-alias-state-warn-primary); animation: dll-pulse 1.1s ease-in-out infinite; }
.dll-dot--failed { background: var(--dsw-alias-state-error-primary); }
@keyframes dll-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
.dll-status-text { font-size: 13px; font-weight: 600; }
.dll-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dll-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dll-btn { height: 28px; padding: 0 12px; font-size: 12.5px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-family: inherit; }
.dll-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dll-btn:disabled { opacity: .45; cursor: default; }
.dll-btn--primary { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dll-btn--danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dll-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.dll-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dll-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dll-input, .dll-select { height: 28px; padding: 0 8px; font-size: 12.5px; font-family: inherit;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); min-width: 0; }
.dll-input:focus, .dll-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dll-hint { font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dll-hint--error { color: var(--dsw-alias-state-error-primary); }
.dll-switch { display: inline-flex; align-items: center; gap: 8px; background: none; border: none;
  padding: 0; cursor: pointer; font-family: inherit; font-size: 12.5px; color: var(--dsw-alias-label-primary); }
.dll-switch-track { width: 34px; height: 20px; border-radius: 10px; flex: none; position: relative;
  background: var(--dsw-alias-state-idle-primary); transition: background .15s ease; }
.dll-switch--on .dll-switch-track { background: var(--dsw-alias-brand-primary); }
.dll-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-bg-base); transition: transform .15s ease; }
.dll-switch--on .dll-switch-knob { transform: translateX(14px); }
.dll-log { margin: 0; max-height: 170px; overflow: auto; padding: 8px 10px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); font-size: 11px; line-height: 1.55;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; word-break: break-all; color: var(--dsw-alias-label-secondary); }
.dll-note { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px;
  padding: 7px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); }
.dll-note--warn { color: var(--dsw-alias-state-warn-primary); }
.dll-note--ok { color: var(--dsw-alias-state-success-primary); }
.dll-note--error { color: var(--dsw-alias-state-error-primary); }
.dll-readonly { height: 28px; display: flex; align-items: center; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dll-policy { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline;
  padding: 8px 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2);
  font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dll-policy-title { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dll-caps { display: flex; flex-direction: column; gap: 6px; max-height: 300px; overflow: auto; }
.dll-cap { border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 9px;
  display: flex; flex-direction: column; gap: 3px; background: var(--dsw-alias-bg-base); }
.dll-cap-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; }
.dll-cap-time { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.dll-cap-path { color: var(--dsw-alias-label-primary); font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.dll-cap-stat { margin-left: auto; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; font-size: 11.5px; }
.dll-cap-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; line-height: 1.5; }
.dll-grid--nested { margin-top: 10px; }
.dll-card details { display: flex; flex-direction: column; gap: 8px; }
.dll-card details > summary { cursor: pointer; }
.dll-sep { height: 1px; background: var(--dsw-alias-border-l1); margin: 0; border: none; }
`

    const ZH = {
      title: '本地模型',
      desc: '三台本地模型只能常驻一台（8 GB 显存）：在这里选择、启停并调整当前这台。',
      modelCard: '当前模型',
      modelSwitch: '切换',
      modelSwitching: '正在切换…',
      modelConfirm: '切换会停掉当前模型、再启动目标（约 3–9 秒），要现在换吗？',
      modelOther: '另一台正在运行',
      modelStrength: '特点',
      temperature: '采样温度',
      temperatureHint: 'temperature；LFM3 的脚本固定用 0。',
      switched: '已切换模型',
      switchedStarted: '已切换并启动',
      desc: '本机 llama.cpp 上的 Qwen3.5-4B。这里启停服务并调整启动参数；模型选择器里的「本地 Qwen3.5 4B」用的就是它。',
      service: '服务状态',
      params: '启动参数',
      start: '启动',
      stop: '停止',
      restart: '重启',
      apply: '应用改动并重启',
      save: '保存',
      saved: '已保存',
      saving: '正在保存…',
      starting: '正在启动…',
      stopping: '正在停止…',
      restarting: '正在重启…',
      ready: '已就绪',
      readyExternal: '已就绪（外部启动）',
      loading: '加载中…',
      stopped: '已停止',
      failed: '启动失败',
      failedTitle: '失败原因',
      logTitle: '错误日志末尾',
      loadTime: '加载耗时',
      seconds: '秒',
      pid: 'PID',
      port: '端口',
      vram: '显存',
      ctx: '上下文长度',
      switches: '切换会停掉当前模型、再启动目标（约 3–9 秒），要现在换吗？',
      pathsCard: '部署路径',
      pathsHint: '把千问装到别处时改这里：留空的项按「安装根目录」推导（<root>\\bin\\llama-b12069\\llama-server.exe、<root>\\models、<root>\\logs）。改完点「检测」逐项校验。',
      pathInstall: '安装根目录',
      pathExe: 'llama-server.exe',
      pathModels: '模型目录',
      pathLogs: '日志目录',
      pathEmpty: '留空 = 自动推导',
      detect: '检测',
      detecting: '检测中…',
      detectReady: '部署可用',
      detectIncomplete: '部署不完整',
      detectMissing: '缺失',
      saveCard: '保存与状态',
      ctxHint: 'token 数。保存时同时写入服务器 --ctx-size 与模型路由 contextWindow。范围 512–262144；8 GB 卡建议 ≤ 65536。',
      ctxVramWarn: '上下文超过 65536：8 GB 显存会装不下 KV，驱动把权重分页到系统内存，实测从 ~63 掉到 ~18 tok/s。长对话交给下面的压缩设置。',
      threads: '线程数',
      threadsHint: 'CPU 线程，默认 6。',
      portLabel: '端口',
      portHint: '改端口会同步模型路由的 baseURL，通常下一个请求即生效。',
      vision: '视觉（看图）',
      visionHint: '关闭可省下视觉投影的显存。',
      thinking: '思考模式',
      thinkingHint: '开启后思考会占用单次输出额度，建议同时设置思考预算。',
      model: '主模型',
      modelHint: '来自 models 目录的 .gguf。',
      mmproj: '视觉投影',
      mmprojHint: '配合视觉的 mmproj 文件。',
      dirty: '参数已改但服务还在用旧值，重启后生效。',
      routeMismatch: '模型路由的 baseURL 端口与当前设置不一致，保存一次即可自动同步。',
      routeSynced: '已把模型路由的 baseURL 改为新端口。',
      dir: '安装目录',
      notFound: '找不到文件',
      loadFailed: '读取配置失败',
      actionFailed: '操作失败',
      lang: '中文',
      thinkingCard: '思考与输出',
      budget: '思考预算',
      budgetHint: '思考最多消耗多少 token；0 表示关闭思考。必须小于单次输出上限。',
      preserve: '保留历史思考',
      preserveHint: '关闭后，支持该能力的模板不再把旧轮思考喂回提示词。本机 Qwen3.5 模板实测本就不回灌，这个开关主要留给以后换模型。',
      maxOut: '单次输出上限',
      maxOutHint: '按上下文 1/8 推算，下限 8192、上限 32768；正文实际可用 = 上限 − 思考预算。',
      compactionCard: '上下文压缩',
      compactionOn: '启用自动压缩',
      compactionOnHint: '接近窗口时把旧对话压成摘要，避免请求超出上下文被服务端拒绝。',
      threshold: '触发比例',
      thresholdHint: '用到上下文的这个比例时开始压缩，建议 0.7。',
      retain: '保留最近原文',
      retainHint: '压缩时最近这段对话保留原文，更早的汇总成摘要。',
      summaryModel: '摘要模型',
      summaryFollow: '跟随会话模型（默认）',
      summaryCustom: '自定义 provider / model',
      summaryProvider: 'provider',
      summaryModelField: 'model',
      summaryHint: '压缩要发一次总结请求。指定更快的模型，可以不让这次请求卡在本地 4B 的长预填充上。',
      summaryManualHint: '没拿到模型列表（提供方未配凭据或未响应），直接手填 provider 与 model，例如 deepseek-account / deepseek-flash。',
      policyTitle: '生效策略',
      policyThreshold: '触发点',
      policyRetain: '保留',
      policyCap: '摘要上限',
      policyPresets: '已写入预设',
      policyNone: '尚未写入任何预设',
      syncRoute: '同步路由参数',
      syncCompaction: '同步压缩策略',
      notViable: '压缩参数不可行',
      routeDrift: '模型路由与设置不一致：',
      compactionDrift: '压缩策略未同步：',
      synced: '已同步',
      syncFailed: '同步失败',
      needRestart: '需重启服务生效',
      appliedLive: '已写入',
      presetNote: '预设改动对新建会话生效，已打开会话沿用旧策略。',
      overhead: '固定开销',
      proxyCard: '请求捕获（诊断）',
      proxyHint: '把模型路由指到插件自己的转发端口，就能看到 harness 真实发出的请求：思考是以 reasoning_content 字段、内联 <think> 标签回放，还是根本没带；工具输出又占了多少。',
      proxyOn: '启用捕获代理',
      proxyPort: '代理端口',
      proxyListening: '监听中',
      proxyStopped: '未启动',
      proxyFailed: '代理启动失败',
      routeToProxy: '让模型走代理',
      routeDirect: '改回直连',
      routeNow: '当前路由',
      captures: '最近请求',
      capturesEmpty: '还没有请求。让模型走代理后，切到本地 4B 说一句话就会出现在这里。',
      colMessages: '消息',
      colReasoning: '思考',
      colTools: '工具输出',
      colSchemas: 'schema',
      clear: '清空',
      reasoningField: '字段',
      reasoningInline: '内联',
      hybridCard: '混合工作流',
      hybridHint: '在线模型负责复杂工作；本机 Qwen3.5-4B 通过 local_worker 工具接手图片、视频、文本杂活。开启后工具对所有会话可见。',
      hybridOn: '启用混合模式',
      hybridOnHint: '注册 local_worker 与一段使用准则；关闭后立即移除。',
      hybridOnline: '混合的在线模型',
      hybridFollow: '跟随当前会话',
      hybridChores: '杂活类型',
      choreText: '文本',
      choreTextHint: '翻译、摘要、改写、提取要点、格式化。',
      choreImage: '图片',
      choreImageHint: '看图、OCR、抄写图中文字；每张约 1024 图 token。',
      choreVideo: '视频',
      choreVideoHint: '按等距时间点抽帧后逐帧看，返回带时间戳的文字。',
      videoFrames: '抽帧数',
      videoFramesHint: '1–6 帧，每帧一次本地调用（约 4 秒）。',
      ffmpegPath: 'ffmpeg 路径',
      ffmpegAuto: '留空 = 自动探测',
      ffmpegOk: '已找到',
      ffmpegMissing: '未找到',
      hybridAdvanced: '高级',
      localTimeoutMs: '本地调用超时 (ms)',
      choreMaxInputChars: '文本输入上限 (字符)',
      choreMaxOutputTokens: '输出 token 上限',
      autoStart: '需要时自动拉起本地服务',
      autoStartHint: '关着时若本地没起，工具会直接报错并提示去启动。',
      hybridStatus: '注册状态',
      hybridRegistered: '已注册',
      hybridNotRegistered: '未注册',
      hybridPromptPreview: '提示词预览',
    }

    const EN = {
      title: 'Local models',
      desc: 'Only one of the three local models fits in 8 GB at a time: pick one here, start or stop it, and tune its parameters.',
      modelCard: 'Current model',
      modelSwitch: 'Switch',
      modelSwitching: 'Switching…',
      modelConfirm: 'Switching stops the current model and starts the target (~3-9 s). Continue?',
      modelOther: 'Also running',
      modelStrength: 'Traits',
      temperature: 'temperature',
      temperatureHint: 'Sampling temperature; the LFM3 script pins it to 0.',
      switched: 'Model switched',
      switchedStarted: 'Switched and started',
      desc: 'The Qwen3.5-4B running on llama.cpp on this machine. Start or stop it here and tune its launch parameters; the “本地 Qwen3.5 4B” entry in the model selector talks to it.',
      service: 'Service',
      params: 'Launch parameters',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      apply: 'Apply and restart',
      save: 'Save',
      saved: 'Saved',
      saving: 'Saving…',
      starting: 'Starting…',
      stopping: 'Stopping…',
      restarting: 'Restarting…',
      ready: 'Ready',
      readyExternal: 'Ready (started outside the Harness)',
      loading: 'Loading…',
      stopped: 'Stopped',
      failed: 'Failed to start',
      failedTitle: 'Failure',
      logTitle: 'Tail of the error log',
      loadTime: 'Loaded in',
      seconds: 's',
      pid: 'PID',
      port: 'Port',
      vram: 'VRAM',
      ctx: 'Context size',
      switches: 'Switching stops the current model and starts the target (~3-9 s). Continue?',
      pathsCard: 'Deployment paths',
      pathsHint: 'Point the plugin at a Qwen install elsewhere. Empty fields derive from the install root (<root>\\bin\\llama-b12069\\llama-server.exe, <root>\\models, <root>\\logs). Press Detect to check each one.',
      pathInstall: 'Install root',
      pathExe: 'llama-server.exe',
      pathModels: 'Models directory',
      pathLogs: 'Logs directory',
      pathEmpty: 'empty = derived',
      detect: 'Detect',
      detecting: 'Checking…',
      detectReady: 'Deployment ready',
      detectIncomplete: 'Deployment incomplete',
      detectMissing: 'missing',
      saveCard: 'Save and status',
      ctxHint: 'Tokens of context. Saving also writes --ctx-size and the route contextWindow. Range 512-262144; on an 8 GB card stay at or below 65536.',
      ctxVramWarn: 'Above 65536 the 8 GB card cannot hold the KV cache: the driver pages weights to system memory and generation drops from ~63 to ~18 tok/s. Use the compaction settings below for long conversations.',
      threads: 'Threads',
      threadsHint: 'CPU threads; default 6.',
      portLabel: 'Port',
      portHint: 'Changing it also rewrites the route baseURL, usually from the next request on.',
      vision: 'Vision (images)',
      visionHint: 'Disable it to free the projector\u2019s VRAM.',
      thinking: 'Thinking mode',
      thinkingHint: 'Thinking spends the same output budget; pair it with a thinking budget.',
      model: 'Model file',
      modelHint: 'A .gguf from the models directory.',
      mmproj: 'Vision projector',
      mmprojHint: 'The mmproj file paired with vision.',
      dirty: 'Parameters changed; the running server still uses the old values until you restart.',
      routeMismatch: 'The route baseURL port differs from the configured port. Save once to synchronise it.',
      routeSynced: 'The route baseURL now points at the new port.',
      dir: 'Install directory',
      notFound: 'file not found',
      loadFailed: 'Could not read the configuration',
      actionFailed: 'Action failed',
      lang: 'English',
      thinkingCard: 'Thinking and output',
      budget: 'Thinking budget',
      budgetHint: 'Tokens thinking may spend; 0 disables thinking. Must stay below the output cap.',
      preserve: 'Keep historical thinking',
      preserveHint: 'Off stops templates that support it from re-feeding earlier thoughts; this Qwen3.5 template never does, so the switch mainly matters for other models.',
      maxOut: 'Output cap',
      maxOutHint: 'Derived as context/8, floor 8192, ceiling 32768; usable answer = cap - thinking budget.',
      compactionCard: 'Context compaction',
      compactionOn: 'Enable automatic compaction',
      compactionOnHint: 'Condenses old history before the request outgrows the window and the server rejects it.',
      threshold: 'Trigger ratio',
      thresholdHint: 'Start condensing once this fraction of the window is used; 0.7 is a good default.',
      retain: 'Keep recent tokens',
      retainHint: 'This much recent conversation stays verbatim; older turns become a summary.',
      summaryModel: 'Summary model',
      summaryFollow: 'Follow the session model (default)',
      summaryCustom: 'Custom provider / model',
      summaryProvider: 'provider',
      summaryModelField: 'model',
      summaryHint: 'Compaction sends one summarization request. A faster model keeps it off the local 4B\u2019s long prefill.',
      summaryManualHint: 'No model list was available (provider has no credential or did not answer). Type the provider and model directly, e.g. deepseek-account / deepseek-flash.',
      policyTitle: 'Effective policy',
      policyThreshold: 'Trigger',
      policyRetain: 'Retain',
      policyCap: 'Summary cap',
      policyPresets: 'Written to presets',
      policyNone: 'Not written to any preset yet',
      syncRoute: 'Sync route numbers',
      syncCompaction: 'Sync compaction policy',
      notViable: 'Compaction cannot work with these numbers',
      routeDrift: 'Route differs from settings: ',
      compactionDrift: 'Compaction policy not synced: ',
      synced: 'Synced',
      syncFailed: 'Sync failed',
      needRestart: 'Restart the service to apply',
      appliedLive: 'written',
      presetNote: 'Preset changes apply to new sessions; open sessions keep the policy they mounted with.',
      overhead: 'Fixed overhead',
      proxyCard: 'Request capture (diagnostic)',
      proxyHint: 'Point the route at the plugin\u2019s own forwarder to see what the harness really sends: whether thinking arrives as `reasoning_content`, as inline <think> tags, or not at all \u2014 and how much tool output the prompt carries.',
      proxyOn: 'Enable capture proxy',
      proxyPort: 'Proxy port',
      proxyListening: 'listening',
      proxyStopped: 'not listening',
      proxyFailed: 'proxy failed to start',
      routeToProxy: 'Route model through proxy',
      routeDirect: 'Back to direct',
      routeNow: 'Current route',
      captures: 'Recent requests',
      capturesEmpty: 'Nothing captured yet. Route the model through the proxy, then send one message on the local model.',
      colMessages: 'msgs',
      colReasoning: 'thinking',
      colTools: 'tool text',
      colSchemas: 'schemas',
      clear: 'Clear',
      reasoningField: 'field',
      reasoningInline: 'inline',
      hybridCard: 'Hybrid workflow',
      hybridHint: 'The online model does the hard work; the local Qwen3.5-4B takes images, video frames and text chores through the local_worker tool. Enabling it exposes the tool to every session.',
      hybridOn: 'Enable hybrid mode',
      hybridOnHint: 'Registers local_worker plus its usage guidance; turning it off removes both at once.',
      hybridOnline: 'Online model to pair with',
      hybridFollow: 'Follow the current session',
      hybridChores: 'Chore types',
      choreText: 'Text',
      choreTextHint: 'Translate, summarise, rewrite, extract points, format.',
      choreImage: 'Images',
      choreImageHint: 'Read images, OCR, transcribe visible text; ~1024 image tokens each.',
      choreVideo: 'Video',
      choreVideoHint: 'Sample evenly spaced frames and describe each with a timestamp.',
      videoFrames: 'Frames',
      videoFramesHint: '1-6 frames, one local call each (~4 s).',
      ffmpegPath: 'ffmpeg path',
      ffmpegAuto: 'empty = auto-detect',
      ffmpegOk: 'found',
      ffmpegMissing: 'missing',
      hybridAdvanced: 'Advanced',
      localTimeoutMs: 'Local call timeout (ms)',
      choreMaxInputChars: 'Max text input (chars)',
      choreMaxOutputTokens: 'Max output tokens',
      autoStart: 'Start the local server when needed',
      autoStartHint: 'When off, a chore fails with a hint to start the server instead of starting it silently.',
      hybridStatus: 'Registration',
      hybridRegistered: 'registered',
      hybridNotRegistered: 'not registered',
      hybridPromptPreview: 'Prompt preview',
    }

    function pickLanguage() {
      const raw = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
        ? navigator.language.toLowerCase()
        : 'zh'
      return raw.startsWith('en') ? 'en' : 'zh'
    }

    const DICT = pickLanguage() === 'en' ? EN : ZH
    /** Which cards the user left expanded, persisted across reloads. */
    const CARD_KEY = 'dsh-local-llm:cards'
    const t = (key) => (DICT[key] === undefined ? key : DICT[key])

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error ?? `HTTP ${response.status}`)
      }
      return await response.json()
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    function formatSeconds(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      return value < 10 ? value.toFixed(1) : String(Math.round(value))
    }

    function formatVram(vram) {
      if (vram === null || vram === undefined) return null
      const used = (vram.usedMiB / 1024).toFixed(1)
      const total = (vram.totalMiB / 1024).toFixed(1)
      return `${used} / ${total} GB`
    }

    const PHASE_TONE = { ready: 'ready', starting: 'starting', failed: 'failed', stopped: 'idle' }

    function Card(props) {
      const { title, id, open, onToggle, children } = props
      const body = Array.isArray(children) ? children.flat() : [children]
      return h(
        'section',
        { className: 'dll-card', 'data-card': id },
        h(
          'button',
          {
            type: 'button',
            className: 'dll-card-head',
            'aria-expanded': open === true,
            onClick: () => onToggle(id),
          },
          h('span', { className: 'dll-caret' }, open === true ? '▾' : '▸'),
          h('span', { className: 'dll-card-title' }, title),
        ),
        open === true ? h('div', { className: 'dll-card-body' }, body) : null,
      )
    }

    function Field(props) {
      return h(
        'div',
        { className: 'dll-field' },
        h('label', { className: 'dll-label', htmlFor: props.id }, props.label),
        props.control,
        props.hint === undefined ? null : h('div', { className: 'dll-hint' }, props.hint),
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked === true,
          className: `dll-switch${props.checked ? ' dll-switch--on' : ''}`,
          onClick: () => props.onChange(!props.checked),
        },
        h('span', { className: 'dll-switch-track' }, h('span', { className: 'dll-switch-knob' })),
        h('span', null, props.checked ? (props.on ?? '开') : (props.off ?? '关')),
      )
    }

    function numberInput(id, value, onChange, min, max) {
      return h('input', {
        id,
        type: 'number',
        className: 'dll-input',
        value,
        min,
        max,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function StatusCard(props) {
      const { status } = props
      const phase = status?.phase ?? 'stopped'
      const tone = PHASE_TONE[phase] ?? 'idle'
      const external = status?.external === true

      let label
      if (phase === 'ready') label = external ? t('readyExternal') : t('ready')
      else if (phase === 'starting') label = t('loading')
      else if (phase === 'failed') label = t('failed')
      else label = t('stopped')

      const meta = []
      if (phase === 'ready' && status?.loadSeconds !== null && status?.loadSeconds !== undefined) {
        meta.push(`${t('loadTime')} ${formatSeconds(status.loadSeconds)} ${t('seconds')}`)
      }
      if (phase === 'starting' && status?.elapsedSeconds !== null) {
        meta.push(`${formatSeconds(status.elapsedSeconds)} ${t('seconds')}`)
      }
      if (status?.pid !== null && status?.pid !== undefined) meta.push(`${t('pid')} ${status.pid}`)
      if (status?.port !== undefined) meta.push(`${t('port')} ${status.port}`)
      const vram = formatVram(status?.vram)
      if (vram !== null) meta.push(`${t('vram')} ${vram}`)

      const busy = props.busy
      const running = phase === 'ready' || phase === 'starting'

      return h(
        Card,
        { id: 'status', title: t('service'), open: props.open, onToggle: props.onToggle },
        h(
          'div',
          { className: 'dll-status' },
          h('span', { className: `dll-dot dll-dot--${tone}` }),
          h('span', { className: 'dll-status-text' }, label),
          meta.length > 0 ? h('span', { className: 'dll-meta' }, meta.join(' · ')) : null,
        ),
        status?.installDir !== undefined
          ? h('div', { className: 'dll-hint' }, `${t('dir')}: ${status.installDir}`)
          : null,
        h(
          'div',
          { className: 'dll-row' },
          h('button', {
            type: 'button',
            className: 'dll-btn dll-btn--primary',
            disabled: busy !== null || running,
            onClick: () => props.onStart(),
          }, busy === 'start' ? t('starting') : t('start')),
          h('button', {
            type: 'button',
            className: 'dll-btn dll-btn--danger',
            disabled: busy !== null || (!running && status?.pid === null),
            onClick: () => props.onStop(),
          }, busy === 'stop' ? t('stopping') : t('stop')),
          h('button', {
            type: 'button',
            className: 'dll-btn',
            disabled: busy !== null || !running,
            onClick: () => props.onRestart(),
          }, busy === 'restart' ? t('restarting') : t('restart')),
          status?.dirty === true && running
            ? h('button', {
              type: 'button',
              className: 'dll-btn dll-btn--primary',
              disabled: busy !== null,
              onClick: () => props.onRestart(),
            }, t('apply'))
            : null,
        ),
        props.actionError !== null
          ? h('div', { className: 'dll-note dll-note--error' }, `${t('actionFailed')}: ${props.actionError}`)
          : null,
        phase === 'failed'
          ? h(
            'div',
            null,
            h('div', { className: 'dll-hint dll-hint--error' }, `${t('failedTitle')}: ${status?.error ?? ''}`),
            Array.isArray(status?.logTail) && status.logTail.length > 0
              ? h(
                'details',
                { open: true },
                h('summary', { className: 'dll-hint' }, t('logTitle')),
                h('pre', { className: 'dll-log' }, status.logTail.join('\n')),
              )
              : null,
          )
          : null,
      )
    }

    function ParamsCard(props) {
      const { cfg, form, set } = props
      const fields = cfg?.model?.fields ?? []
      const has = (key) => fields.includes(key)

      const modelOptions = (cfg?.files ?? []).map((file) => h('option', { key: file, value: file }, file))
      if (form.modelFile !== '' && !(cfg?.files ?? []).includes(form.modelFile)) {
        modelOptions.push(h('option', { key: form.modelFile, value: form.modelFile }, `${form.modelFile} (${t('notFound')})`))
      }
      const mmprojOptions = [
        h('option', { key: '', value: '' }, '—'),
        ...(cfg?.mmproj ?? []).map((file) => h('option', { key: file, value: file }, file)),
      ]
      if (form.mmprojFile !== '' && !(cfg?.mmproj ?? []).includes(form.mmprojFile)) {
        mmprojOptions.push(h('option', { key: form.mmprojFile, value: form.mmprojFile }, `${form.mmprojFile} (${t('notFound')})`))
      }

      return h(
        Card,
        { id: 'params', title: t('params'), open: props.open, onToggle: props.onToggle },
        h(
          'div',
          { className: 'dll-grid' },
          has('contextSize') ? h(Field, {
            id: 'dll-ctx',
            label: t('ctx'),
            hint: t('ctxHint'),
            control: numberInput('dll-ctx', form.contextSize, (value) => set('contextSize', value), 512, 262144),
          }) : null,
          has('threads') ? h(Field, {
            id: 'dll-threads',
            label: t('threads'),
            hint: t('threadsHint'),
            control: numberInput('dll-threads', form.threads, (value) => set('threads', value), 1, 64),
          }) : null,
          has('port') ? h(Field, {
            id: 'dll-port',
            label: t('portLabel'),
            hint: t('portHint'),
            control: numberInput('dll-port', form.port, (value) => set('port', value), 1024, 65535),
          }) : null,
          has('modelFile') ? h(Field, {
            id: 'dll-model',
            label: t('model'),
            hint: t('modelHint'),
            control: h('select', {
              id: 'dll-model',
              className: 'dll-select',
              value: form.modelFile,
              onChange: (event) => set('modelFile', event.target.value),
            }, modelOptions),
          }) : null,
          has('mmprojFile') ? h(Field, {
            id: 'dll-mmproj',
            label: t('mmproj'),
            hint: t('mmprojHint'),
            control: h('select', {
              id: 'dll-mmproj',
              className: 'dll-select',
              value: form.mmprojFile,
              onChange: (event) => set('mmprojFile', event.target.value),
            }, mmprojOptions),
          }) : null,
          has('vision') ? h(Field, {
            id: 'dll-vision',
            label: t('vision'),
            hint: t('visionHint'),
            control: h(Switch, {
              checked: form.vision === true,
              onChange: (value) => set('vision', value),
            }),
          }) : null,
          has('temperature') ? h(Field, {
            id: 'dll-temperature',
            label: t('temperature'),
            hint: t('temperatureHint'),
            control: numberInput('dll-temperature', form.temperature, (value) => set('temperature', value), 0, 2),
          }) : null,
        ),
        !has('thinking') ? null : h(
          'details',
          null,
          h('summary', { className: 'dll-hint' }, t('thinkingHint')),
        ),
        Number(form.contextSize) > 65536
          ? h('div', { className: 'dll-note dll-note--warn' }, t('ctxVramWarn'))
          : null,
      )
    }

    function ThinkingCard(props) {
      const { cfg, form, set } = props
      const cap = cfg?.derived?.maxTokens
      const thinkingOn = form.thinking === true

      return h(
        Card,
        { id: 'thinking', title: t('thinkingCard'), open: props.open, onToggle: props.onToggle },
        h(
          'div',
          { className: 'dll-grid' },
          h(Field, {
            id: 'dll-thinking',
            label: t('thinking'),
            hint: t('thinkingHint'),
            control: h(Switch, { checked: thinkingOn, onChange: (value) => set('thinking', value) }),
          }),
          h(Field, {
            id: 'dll-budget',
            label: t('budget'),
            hint: t('budgetHint'),
            control: numberInput(
              'dll-budget',
              form.reasoningBudget,
              (value) => set('reasoningBudget', value),
              0,
              16384,
            ),
          }),
          h(Field, {
            id: 'dll-preserve',
            label: t('preserve'),
            hint: t('preserveHint'),
            control: h(Switch, {
              checked: form.reasoningPreserve === true,
              onChange: (value) => set('reasoningPreserve', value),
            }),
          }),
          h(Field, {
            id: 'dll-maxout',
            label: t('maxOut'),
            hint: t('maxOutHint'),
            control: h('div', { className: 'dll-readonly' }, cap === undefined ? '—' : `${cap} token`),
          }),
        ),
      )
    }

    function CompactionCard(props) {
      const { cfg, form, set, syncing, onSync } = props
      const derived = cfg?.derived?.compaction
      const presets = cfg?.compaction?.presets ?? []
      const drifted = (cfg?.compaction?.drift ?? []).length > 0
      const viable = derived?.viable !== false

      const selection = form.summarizationProvider !== '' && form.summarizationModel !== ''
        ? `${form.summarizationProvider}::${form.summarizationModel}`
        : ''
      const summaryOptions = [h('option', { key: '', value: '' }, t('summaryFollow'))]
      for (const group of cfg?.summarization?.choices ?? []) {
        for (const model of group.models ?? []) {
          const value = `${group.provider}::${model.id}`
          summaryOptions.push(h('option', { key: value, value }, `${group.name} · ${model.name}`))
        }
      }
      if (selection !== '' && !summaryOptions.some((option) => option.props.value === selection)) {
        summaryOptions.push(h('option', { key: selection, value: selection }, selection))
      }
      const hasChoices = (cfg?.summarization?.choices ?? []).length > 0
      const summaryControl = hasChoices
        ? h('select', {
          id: 'dll-summary',
          className: 'dll-select',
          value: selection,
          onChange: (event) => {
            const raw = event.target.value
            if (raw === '') {
              set('summarizationProvider', '')
              set('summarizationModel', '')
              return
            }
            const [provider, ...rest] = raw.split('::')
            set('summarizationProvider', provider)
            set('summarizationModel', rest.join('::'))
          },
        }, summaryOptions)
        : h(
          'div',
          { className: 'dll-row' },
          h('input', {
            id: 'dll-summary',
            className: 'dll-input',
            value: form.summarizationProvider,
            placeholder: t('summaryProvider'),
            onChange: (event) => set('summarizationProvider', event.target.value),
          }),
          h('input', {
            className: 'dll-input',
            value: form.summarizationModel,
            placeholder: t('summaryModelField'),
            onChange: (event) => set('summarizationModel', event.target.value),
          }),
        )

      return h(
        Card,
        { id: 'compaction', title: t('compactionCard'), open: props.open, onToggle: props.onToggle },
        h(
          'div',
          { className: 'dll-grid' },
          h(Field, {
            id: 'dll-compaction-on',
            label: t('compactionOn'),
            hint: t('compactionOnHint'),
            control: h(Switch, {
              checked: form.compactionEnabled !== false,
              onChange: (value) => set('compactionEnabled', value),
            }),
          }),
          h(Field, {
            id: 'dll-ratio',
            label: t('threshold'),
            hint: t('thresholdHint'),
            control: numberInput('dll-ratio', form.compactionThresholdRatio, (value) => set('compactionThresholdRatio', value), 0.3, 0.9),
          }),
          h(Field, {
            id: 'dll-retain',
            label: t('retain'),
            hint: t('retainHint'),
            control: numberInput('dll-retain', form.compactionRetainTokens, (value) => set('compactionRetainTokens', value), 1024, 65536),
          }),
          h(Field, {
            id: 'dll-summary',
            label: t('summaryModel'),
            hint: hasChoices ? t('summaryHint') : t('summaryManualHint'),
            control: summaryControl,
          }),
        ),
        derived === undefined || derived === null
          ? null
          : h(
            'div',
            { className: 'dll-policy' },
            h('span', { className: 'dll-policy-title' }, t('policyTitle')),
            h('span', null, `${t('policyThreshold')} ${derived.threshold}`),
            h('span', null, `${t('policyRetain')} ${derived.retainTokens}`),
            h('span', null, `${t('policyCap')} ${derived.summaryCap}`),
            h('span', null, `${t('overhead')} ${derived.overhead}`),
          ),
        h(
          'div',
          { className: 'dll-hint' },
          presets.length > 0
            ? `${t('policyPresets')}: ${presets.map((preset) => `${preset.id}${preset.applied ? ' ✓' : ' ✗'}`).join(' · ')}`
            : t('policyNone'),
        ),
        viable
          ? null
          : h('div', { className: 'dll-note dll-note--error' }, `${t('notViable')}: ${derived?.reason ?? ''}`),
        drifted
          ? h(
            'div',
            { className: 'dll-note dll-note--warn dll-row' },
            h('span', null, `${t('compactionDrift')}${(cfg?.compaction?.drift ?? []).join('；')}`),
            h('button', {
              type: 'button',
              className: 'dll-btn',
              disabled: syncing || !viable,
              onClick: () => onSync(),
            }, syncing ? '…' : t('syncCompaction')),
          )
          : null,
        h('div', { className: 'dll-hint' }, t('presetNote')),
      )
    }

    function formatChars(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
    }

    function ProxyCard(props) {
      const { form, set, status, saving, onApplyRoute, onClearCaptures } = props
      const proxy = status?.proxy ?? null
      const captures = Array.isArray(proxy?.captures) ? [...proxy.captures].reverse() : []
      const listening = proxy?.listening === true

      return h(
        Card,
        { id: 'proxy', title: t('proxyCard'), open: props.open, onToggle: props.onToggle },
        h('p', { className: 'dll-hint' }, t('proxyHint')),
        h(
          'div',
          { className: 'dll-grid' },
          h(Field, {
            id: 'dll-proxy-on',
            label: t('proxyOn'),
            hint: `${t('routeNow')}: ${proxy?.effectiveRoute ?? '—'}`,
            control: h(Switch, {
              checked: form.proxyEnabled === true,
              onChange: (value) => set('proxyEnabled', value),
            }),
          }),
          h(Field, {
            id: 'dll-proxy-port',
            label: t('proxyPort'),
            hint: proxy?.error === null || proxy?.error === undefined
              ? `${listening ? t('proxyListening') : t('proxyStopped')} · ${proxy?.url ?? ''}`
              : `${t('proxyFailed')}: ${proxy.error}`,
            control: numberInput('dll-proxy-port', form.proxyPort, (value) => set('proxyPort', value), 1024, 65535),
          }),
          h(Field, {
            id: 'dll-proxy-route',
            label: t('routeNow'),
            hint: form.routeViaProxy === true ? 'provider → 代理 → llama-server' : 'provider → llama-server',
            control: h(
              'div',
              { className: 'dll-row' },
              h('button', {
                type: 'button',
                className: `dll-btn${form.routeViaProxy === true ? ' dll-btn--primary' : ''}`,
                disabled: saving,
                onClick: () => onApplyRoute(true),
              }, t('routeToProxy')),
              h('button', {
                type: 'button',
                className: `dll-btn${form.routeViaProxy !== true ? ' dll-btn--primary' : ''}`,
                disabled: saving,
                onClick: () => onApplyRoute(false),
              }, t('routeDirect')),
            ),
          }),
        ),
        h('hr', { className: 'dll-sep' }),
        h(
          'div',
          { className: 'dll-row' },
          h('span', { className: 'dll-policy-title' }, `${t('captures')} (${captures.length})`),
          h('button', {
            type: 'button',
            className: 'dll-btn',
            disabled: captures.length === 0,
            onClick: () => onClearCaptures(),
          }, t('clear')),
        ),
        captures.length === 0
          ? h('div', { className: 'dll-hint' }, t('capturesEmpty'))
          : h(
            'div',
            { className: 'dll-caps' },
            captures.map((capture, index) => {
              const summary = capture.summary ?? {}
              const roles = Object.entries(summary.byRole ?? {})
                .map(([role, count]) => `${role}:${count}`)
                .join(' ')
              return h(
                'div',
                { className: 'dll-cap', key: `${capture.at}-${index}` },
                h(
                  'div',
                  { className: 'dll-cap-head' },
                  h('span', { className: 'dll-cap-time' }, new Date(capture.at).toLocaleTimeString()),
                  h('span', { className: 'dll-cap-path' }, capture.path),
                  h(
                    'span',
                    { className: capture.status === 200 ? 'dll-cap-stat' : 'dll-cap-stat dll-hint--error' },
                    `${capture.status}${capture.error === null || capture.error === undefined ? '' : ` · ${capture.error}`} · ${capture.ms}ms`,
                  ),
                ),
                summary.messages === null || summary.messages === undefined
                  ? h('div', { className: 'dll-cap-meta' }, `${formatChars(summary.bytes)} bytes (not JSON)`)
                  : h(
                    'div',
                    { className: 'dll-cap-meta' },
                    `${t('colMessages')} ${summary.messages} (${roles})`,
                    ` · ${t('colReasoning')} ${t('reasoningField')} ${formatChars(summary.reasoningFieldChars)} / ${t('reasoningInline')} ${summary.inlineThinkBlocks}`,
                    ` · ${t('colTools')} ${formatChars(summary.toolChars)}`,
                    ` · ${t('colSchemas')} ${formatChars(summary.toolsBytes)}B`,
                    summary.maxTokens === null ? '' : ` · max_tokens ${summary.maxTokens}`,
                    summary.stream === true ? ' · stream' : '',
                    capture.usage === undefined
                      ? ''
                      : ` · in ${capture.usage.prompt_tokens ?? '?'} / out ${capture.usage.completion_tokens ?? '?'}`,
                  ),
              )
            }),
          ),
      )
    }

    function HybridCard(props) {
      const { cfg, form, set, status } = props
      const hybrid = cfg?.hybrid
      const choices = cfg?.summarization?.choices ?? []
      const selection = form.hybridOnlineProvider !== '' && form.hybridOnlineModel !== ''
        ? `${form.hybridOnlineProvider}::${form.hybridOnlineModel}`
        : ''

      const options = [h('option', { key: '', value: '' }, t('hybridFollow'))]
      for (const group of choices) {
        for (const model of group.models ?? []) {
          const value = `${group.provider}::${model.id}`
          options.push(h('option', { key: value, value }, `${group.name} · ${model.name}`))
        }
      }
      if (selection !== '' && !options.some((option) => option.props.value === selection)) {
        options.push(h('option', { key: selection, value: selection }, selection))
      }

      const registered = status?.hybrid?.registered === true
      const ffmpeg = hybrid?.ffmpeg

      return h(
        Card,
        { id: 'hybrid', title: t('hybridCard'), open: props.open, onToggle: props.onToggle },
        h('p', { className: 'dll-hint' }, t('hybridHint')),
        h(
          'div',
          { className: 'dll-grid' },
          h(Field, {
            id: 'dll-hybrid-on',
            label: t('hybridOn'),
            hint: t('hybridOnHint'),
            control: h(Switch, {
              checked: form.hybridEnabled === true,
              onChange: (value) => set('hybridEnabled', value),
            }),
          }),
          h(Field, {
            id: 'dll-hybrid-online',
            label: t('hybridOnline'),
            hint: hybrid === undefined
              ? ''
              : `${hybrid.onlineProvider === '' ? t('hybridFollow') : `${hybrid.onlineProvider}/${hybrid.onlineModel}`}`,
            control: h('select', {
              id: 'dll-hybrid-online',
              className: 'dll-select',
              value: selection,
              onChange: (event) => {
                const raw = event.target.value
                if (raw === '') {
                  set('hybridOnlineProvider', '')
                  set('hybridOnlineModel', '')
                  return
                }
                const [provider, ...rest] = raw.split('::')
                set('hybridOnlineProvider', provider)
                set('hybridOnlineModel', rest.join('::'))
              },
            }, options),
          }),
          h(Field, {
            id: 'dll-chore-text',
            label: `${t('hybridChores')} · ${t('choreText')}`,
            hint: t('choreTextHint'),
            control: h(Switch, {
              checked: form.choreText === true,
              onChange: (value) => set('choreText', value),
            }),
          }),
          h(Field, {
            id: 'dll-chore-image',
            label: `${t('hybridChores')} · ${t('choreImage')}`,
            hint: t('choreImageHint'),
            control: h(Switch, {
              checked: form.choreImage === true,
              onChange: (value) => set('choreImage', value),
            }),
          }),
          h(Field, {
            id: 'dll-chore-video',
            label: `${t('hybridChores')} · ${t('choreVideo')}`,
            hint: t('choreVideoHint'),
            control: h(Switch, {
              checked: form.choreVideo === true,
              onChange: (value) => set('choreVideo', value),
            }),
          }),
          h(Field, {
            id: 'dll-frames',
            label: t('videoFrames'),
            hint: t('videoFramesHint'),
            control: numberInput('dll-frames', form.videoFrames, (value) => set('videoFrames', value), 1, 6),
          }),
          h(Field, {
            id: 'dll-ffmpeg',
            label: t('ffmpegPath'),
            hint: ffmpeg === undefined
              ? t('ffmpegAuto')
              : ffmpeg.ok === true
                ? `${t('ffmpegOk')}: ${ffmpeg.path}${ffmpeg.note === undefined ? '' : ` (${ffmpeg.note})`}`
                : `${t('ffmpegMissing')}: ${ffmpeg.reason ?? ''}`,
            control: h('input', {
              id: 'dll-ffmpeg',
              className: 'dll-input',
              value: form.ffmpegPath,
              placeholder: t('ffmpegAuto'),
              onChange: (event) => set('ffmpegPath', event.target.value),
            }),
          }),
        ),
        h(
          'details',
          null,
          h('summary', { className: 'dll-hint' }, t('hybridAdvanced')),
          h(
            'div',
            { className: 'dll-grid dll-grid--nested' },
            h(Field, {
              id: 'dll-local-timeout',
              label: t('localTimeoutMs'),
              control: numberInput('dll-local-timeout', form.localTimeoutMs, (value) => set('localTimeoutMs', value), 5000, 600000),
            }),
            h(Field, {
              id: 'dll-max-input',
              label: t('choreMaxInputChars'),
              control: numberInput('dll-max-input', form.choreMaxInputChars, (value) => set('choreMaxInputChars', value), 1000, 100000),
            }),
            h(Field, {
              id: 'dll-max-out',
              label: t('choreMaxOutputTokens'),
              control: numberInput('dll-max-out', form.choreMaxOutputTokens, (value) => set('choreMaxOutputTokens', value), 64, 4096),
            }),
            h(Field, {
              id: 'dll-autostart',
              label: t('autoStart'),
              hint: t('autoStartHint'),
              control: h(Switch, {
                checked: form.autoStartLocal === true,
                onChange: (value) => set('autoStartLocal', value),
              }),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dll-hint' },
          `${t('hybridStatus')}: ${registered ? t('hybridRegistered') : t('hybridNotRegistered')}`
            + (status?.hybrid?.error === null || status?.hybrid?.error === undefined ? '' : ` · ${status.hybrid.error}`),
        ),
        hybrid?.prompt === undefined
          ? null
          : h(
            'details',
            null,
            h('summary', { className: 'dll-hint' }, t('hybridPromptPreview')),
            h('pre', { className: 'dll-log' }, hybrid.prompt),
          ),
      )
    }

    function PathsCard(props) {
      const { cfg, form, set, report, detecting, onDetect } = props
      const items = report?.items ?? []
      const labelOf = (key) => ({
        installDir: t('pathInstall'),
        exePath: t('pathExe'),
        modelsDir: t('pathModels'),
        logsDir: t('pathLogs'),
      }[key] ?? key)
      const textInput = (id, value, key, placeholder) => h('input', {
        id,
        className: 'dll-input',
        value,
        placeholder,
        onChange: (event) => set(key, event.target.value),
      })

      return h(
        Card,
        { id: 'paths', title: t('pathsCard'), open: props.open, onToggle: props.onToggle },
        h('p', { className: 'dll-hint' }, t('pathsHint')),
        h(
          'div',
          { className: 'dll-grid' },
          h(Field, {
            id: 'dll-install',
            label: t('pathInstall'),
            hint: cfg?.paths?.resolved?.root ?? '',
            control: textInput('dll-install', form.installDir, 'installDir', t('pathEmpty')),
          }),
          h(Field, {
            id: 'dll-exe',
            label: t('pathExe'),
            hint: cfg?.paths?.resolved?.exe ?? '',
            control: textInput('dll-exe', form.exePath, 'exePath', t('pathEmpty')),
          }),
          h(Field, {
            id: 'dll-models-dir',
            label: t('pathModels'),
            hint: cfg?.paths?.resolved?.models ?? '',
            control: textInput('dll-models-dir', form.modelsDir, 'modelsDir', t('pathEmpty')),
          }),
          h(Field, {
            id: 'dll-logs-dir',
            label: t('pathLogs'),
            hint: cfg?.paths?.resolved?.logs ?? '',
            control: textInput('dll-logs-dir', form.logsDir, 'logsDir', t('pathEmpty')),
          }),
        ),
        h(
          'div',
          { className: 'dll-row' },
          h('button', {
            type: 'button',
            className: 'dll-btn dll-btn--primary',
            disabled: detecting,
            onClick: () => onDetect(),
          }, detecting ? t('detecting') : t('detect')),
          report === null
            ? null
            : h('span', { className: report.ready === true ? 'dll-note dll-note--ok' : 'dll-note dll-note--warn' },
              report.ready === true ? t('detectReady') : t('detectIncomplete')),
        ),
        items.length === 0
          ? null
          : h(
            'div',
            { className: 'dll-caps' },
            items.map((item) => h(
              'div',
              { className: 'dll-cap', key: item.key },
              h(
                'div',
                { className: 'dll-cap-head' },
                h('span', { className: 'dll-cap-path' }, labelOf(item.key)),
                h('span', { className: 'dll-cap-stat' }, item.exists ? '✓' : t('detectMissing')),
              ),
              h('div', { className: 'dll-cap-meta' }, item.path),
            )),
          ),
      )
    }

    function LocalLlmSettings() {
      const [status, setStatus] = useState(null)
      const [cfg, setCfg] = useState(null)
      const [form, setForm] = useState({
        port: 8080,
        contextSize: 32768,
        threads: 6,
        vision: true,
        thinking: false,
        modelFile: '',
        mmprojFile: '',
        temperature: 0,
        reasoningBudget: 2048,
        reasoningPreserve: false,
        compactionEnabled: true,
        compactionThresholdRatio: 0.7,
        compactionRetainTokens: 8192,
        summarizationProvider: '',
        summarizationModel: '',
        proxyEnabled: false,
        proxyPort: 8091,
        routeViaProxy: false,
        hybridEnabled: false,
        hybridOnlineProvider: '',
        hybridOnlineModel: '',
        choreText: true,
        choreImage: true,
        choreVideo: true,
        videoFrames: 3,
        ffmpegPath: '',
        localTimeoutMs: 120000,
        choreMaxInputChars: 24000,
        choreMaxOutputTokens: 1024,
        autoStartLocal: false,
        installDir: '',
        exePath: '',
        modelsDir: '',
        logsDir: '',
      })
      const [loadError, setLoadError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [saving, setSaving] = useState(false)
      const [syncing, setSyncing] = useState(false)
      const [note, setNote] = useState(null)
      const [noteTone, setNoteTone] = useState('ok')
      const [pathReport, setPathReport] = useState(null)
      const [detecting, setDetecting] = useState(false)
      const [cards, setCards] = useState(() => {
        try {
          const raw = window.localStorage.getItem(CARD_KEY)
          return raw === null ? {} : JSON.parse(raw)
        } catch {
          return {}
        }
      })

      const isOpen = (id) => (cards[id] === undefined ? id === 'status' : cards[id] === true)
      const toggleCard = (id) => {
        setCards((current) => {
          const next = { ...current, [id]: !(current[id] === true) }
          try {
            window.localStorage.setItem(CARD_KEY, JSON.stringify(next))
          } catch {
            // Storage can be unavailable; collapse state is cosmetic.
          }
          return next
        })
      }

      const onDetect = async () => {
        setDetecting(true)
        try {
          setPathReport(await postJson('/local-llm/detect', {}))
        } catch (cause) {
          setActionError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setDetecting(false)
        }
      }

      const applyConfig = useCallback((view) => {
        setCfg(view)
        if (view.paths !== undefined) setPathReport(view.paths)
        const s = view.settings
        setForm({
          port: s.port,
          contextSize: s.contextSize,
          threads: s.threads,
          vision: s.vision,
          thinking: s.thinking,
          modelFile: s.modelFile,
          mmprojFile: s.mmprojFile ?? '',
          temperature: s.temperature ?? 0,
          reasoningBudget: s.reasoningBudget ?? 2048,
          reasoningPreserve: s.reasoningPreserve === true,
          compactionEnabled: s.compactionEnabled !== false,
          compactionThresholdRatio: s.compactionThresholdRatio ?? 0.7,
          compactionRetainTokens: s.compactionRetainTokens ?? 8192,
          summarizationProvider: s.summarizationProvider ?? '',
          summarizationModel: s.summarizationModel ?? '',
          proxyEnabled: s.proxyEnabled === true,
          proxyPort: s.proxyPort ?? 8091,
          routeViaProxy: s.routeViaProxy === true,
          hybridEnabled: s.hybridEnabled === true,
          hybridOnlineProvider: s.hybridOnlineProvider ?? '',
          hybridOnlineModel: s.hybridOnlineModel ?? '',
          choreText: s.choreText !== false,
          choreImage: s.choreImage !== false,
          choreVideo: s.choreVideo !== false,
          videoFrames: s.videoFrames ?? 3,
          ffmpegPath: s.ffmpegPath ?? '',
          localTimeoutMs: s.localTimeoutMs ?? 120000,
          choreMaxInputChars: s.choreMaxInputChars ?? 24000,
          choreMaxOutputTokens: s.choreMaxOutputTokens ?? 1024,
          autoStartLocal: s.autoStartLocal === true,
          installDir: s.installDir ?? '',
          exePath: s.exePath ?? '',
          modelsDir: s.modelsDir ?? '',
          logsDir: s.logsDir ?? '',
        })
      }, [])

      const refreshConfig = useCallback(async () => {
        try {
          applyConfig(await getJson('/local-llm/config'))
          setLoadError(null)
        } catch (cause) {
          setLoadError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [applyConfig])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const next = await getJson('/local-llm/status')
            if (alive) setStatus(next)
          } catch (cause) {
            if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause))
          }
        }
        tick()
        const timer = setInterval(tick, 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      useEffect(() => {
        refreshConfig()
      }, [refreshConfig])

      const set = useCallback((key, value) => {
        setForm((current) => ({ ...current, [key]: value }))
        setNote(null)
      }, [])

      const run = async (name, call) => {
        setBusy(name)
        setActionError(null)
        try {
          await call()
          await refreshConfig()
          setStatus(await getJson('/local-llm/status'))
        } catch (cause) {
          setActionError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(null)
        }
      }

      const onStart = () => run('start', () => postJson('/local-llm/start', {}))
      const onStop = () => run('stop', () => postJson('/local-llm/stop', {}))
      const onRestart = () => run('restart', () => postJson('/local-llm/restart', {}))

      const onSync = async () => {
        setSyncing(true)
        setNote(null)
        try {
          const result = await postJson('/local-llm/sync', { scope: 'all' })
          await refreshConfig()
          const reason = result.compaction?.ok === false ? result.compaction.reason : null
          setNote(reason === null ? t('synced') : `${t('syncFailed')}: ${reason}`)
          setNoteTone(reason === null ? 'ok' : 'error')
        } catch (cause) {
          setNote(cause instanceof Error ? cause.message : String(cause))
          setNoteTone('error')
        } finally {
          setSyncing(false)
        }
      }

      const onSave = async () => {
        setSaving(true)
        setNote(null)
        try {
          const result = await postJson('/local-llm/config', {
            patch: {
              port: Number(form.port),
              contextSize: Number(form.contextSize),
              threads: Number(form.threads),
              vision: form.vision === true,
              thinking: form.thinking === true,
              modelFile: form.modelFile,
              mmprojFile: form.mmprojFile,
              temperature: Number(form.temperature),
              reasoningBudget: Number(form.reasoningBudget),
              reasoningPreserve: form.reasoningPreserve === true,
              compactionEnabled: form.compactionEnabled !== false,
              compactionThresholdRatio: Number(form.compactionThresholdRatio),
              compactionRetainTokens: Number(form.compactionRetainTokens),
              summarizationProvider: form.summarizationProvider,
              summarizationModel: form.summarizationModel,
              proxyEnabled: form.proxyEnabled === true,
              proxyPort: Number(form.proxyPort),
              routeViaProxy: form.routeViaProxy === true,
              hybridEnabled: form.hybridEnabled === true,
              hybridOnlineProvider: form.hybridOnlineProvider,
              hybridOnlineModel: form.hybridOnlineModel,
              choreText: form.choreText === true,
              choreImage: form.choreImage === true,
              choreVideo: form.choreVideo === true,
              videoFrames: Number(form.videoFrames),
              ffmpegPath: form.ffmpegPath,
              localTimeoutMs: Number(form.localTimeoutMs),
              choreMaxInputChars: Number(form.choreMaxInputChars),
              choreMaxOutputTokens: Number(form.choreMaxOutputTokens),
              autoStartLocal: form.autoStartLocal === true,
              installDir: form.installDir,
              exePath: form.exePath,
              modelsDir: form.modelsDir,
              logsDir: form.logsDir,
            },
          })
          await refreshConfig()

          const compactionFailed = result.compactionSync?.ok === false
          if (compactionFailed) {
            setNote(`${t('syncFailed')}: ${result.compactionSync.reason}`)
            setNoteTone('error')
          } else if (result.providerSync?.updated === true || result.compactionSync?.updated === true) {
            setNote(t('saved'))
            setNoteTone('ok')
          } else {
            setNote(t('saved'))
            setNoteTone('ok')
          }
        } catch (cause) {
          setNote(cause instanceof Error ? cause.message : String(cause))
          setNoteTone('error')
        } finally {
          setSaving(false)
        }
      }

      const onClearCaptures = async () => {
        try {
          await postJson('/local-llm/proxy', { action: 'clear' })
          setStatus(await getJson('/local-llm/status'))
        } catch (cause) {
          setActionError(cause instanceof Error ? cause.message : String(cause))
        }
      }

      /** Flip the route in one click; it also turns the proxy on when routing to it. */
      const onApplyRoute = async (viaProxy) => {
        setSaving(true)
        setNote(null)
        try {
          await postJson('/local-llm/config', {
            patch: {
              proxyEnabled: viaProxy ? true : form.proxyEnabled === true,
              proxyPort: Number(form.proxyPort),
              routeViaProxy: viaProxy,
            },
          })
          await refreshConfig()
          setStatus(await getJson('/local-llm/status'))
          setNote(viaProxy ? t('routeToProxy') : t('routeDirect'))
          setNoteTone('ok')
        } catch (cause) {
          setNote(cause instanceof Error ? cause.message : String(cause))
          setNoteTone('error')
        } finally {
          setSaving(false)
        }
      }


      if (loadError !== null && cfg === null) {
        return h(
          'div',
          { className: 'dll-page' },
          h('style', null, CSS),
          h('p', { className: 'dll-desc dll-hint--error' }, `${t('loadFailed')}: ${loadError}`),
        )
      }

      const routeDrift = cfg?.provider?.drift ?? []
      const lastArgs = status?.args
      const supportsThinking = (cfg?.model?.fields ?? []).includes('thinking')

      return h(
        'div',
        { className: 'dll-page' },
        h('style', null, CSS),
        h('p', { className: 'dll-desc' }, t('desc')),
        h(StatusCard, {
          status,
          busy,
          actionError,
          onStart,
          onStop,
          onRestart,
          open: isOpen('status'),
          onToggle: toggleCard,
        }),
        cfg === null
          ? h('div', { className: 'dll-hint' }, '…')
          : h(ParamsCard, { cfg, form, set, open: isOpen('params'), onToggle: toggleCard }),
        cfg === null
          ? null
          : h(PathsCard, {
            cfg,
            form,
            set,
            report: pathReport,
            detecting,
            onDetect,
            open: isOpen('paths'),
            onToggle: toggleCard,
          }),
        cfg === null || !supportsThinking
          ? null
          : h(ThinkingCard, { cfg, form, set, open: isOpen('thinking'), onToggle: toggleCard }),
        cfg === null
          ? null
          : h(CompactionCard, {
            cfg,
            form,
            set,
            syncing,
            onSync,
            open: isOpen('compaction'),
            onToggle: toggleCard,
          }),
        cfg === null
          ? null
          : h(ProxyCard, {
            form,
            set,
            status,
            saving,
            onApplyRoute,
            onClearCaptures,
            open: isOpen('proxy'),
            onToggle: toggleCard,
          }),
        cfg === null
          ? null
          : h(HybridCard, {
            cfg,
            form,
            set,
            status,
            open: isOpen('hybrid'),
            onToggle: toggleCard,
          }),
        cfg === null
          ? null
          : h(
            Card,
            { id: 'save', title: t('saveCard'), open: isOpen('save'), onToggle: toggleCard },
            h(
              'div',
              { className: 'dll-row' },
              h('button', {
                type: 'button',
                className: 'dll-btn dll-btn--primary',
                disabled: saving || syncing,
                onClick: () => onSave(),
              }, saving ? t('saving') : t('save')),
              h('button', {
                type: 'button',
                className: 'dll-btn',
                disabled: saving || syncing,
                onClick: () => onSync(),
              }, syncing ? '…' : t('syncRoute')),
              note === null
                ? null
                : h('span', { className: `dll-note ${noteTone === 'error' ? 'dll-note--error' : 'dll-note--ok'}` }, note),
            ),
            status?.dirty === true
              ? h('div', { className: 'dll-note dll-note--warn' }, `${t('dirty')} ${t('needRestart')}`)
              : null,
            routeDrift.length > 0
              ? h('div', { className: 'dll-note dll-note--warn' }, `${t('routeDrift')}${routeDrift.join('；')}`)
              : null,
            Array.isArray(lastArgs) && lastArgs.length > 0
              ? h(
                'details',
                null,
                h('summary', { className: 'dll-hint' }, `${t('service')} · args`),
                h('pre', { className: 'dll-log' }, lastArgs.join(' ')),
              )
              : null,
          ),
      )
    }

    return {
      name: 'dsh-local-llm',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'local-llm',
          order: 60,
          label: () => t('title'),
        }, () => h(LocalLlmSettings, null)))
      },
    }
  },
})
