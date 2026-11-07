/**
 * dsh-local-llm — host half.
 *
 * Owns the local llama.cpp server (Qwen3.5-4B) that the profile's `local-qwen`
 * provider talks to: it spawns `llama-server.exe` directly, tracks readiness
 * through `/health`, and answers the Settings page over same-origin HTTP routes
 * under `/local-llm`. Launch parameters live in a plugin-owned JSON state file.
 *
 * It also keeps the two things that decide whether a local session survives past
 * its window in step with those settings:
 * - the provider route in the profile patch (`baseURL` port, `contextWindow`,
 *   `maxTokens`), because those are the numbers the harness budgets with;
 * - a compaction policy for this exact model inside the agent presets, because
 *   the shipped defaults assume a 64K+ window (`headroomTokens: 65536`), which
 *   makes the trigger formula negative on a 32K model and turns every step into
 *   a failing summary request.
 *
 * Design notes:
 * - The server is spawned detached and unref'd, so restarting DSH (or reloading
 *   this plugin) does not kill a model the user is still using. Stop is explicit.
 * - The pid file is the same one `D:\local-llm\start.ps1` writes, so a server the
 *   user started by hand is still discoverable and stoppable from the page.
 * - No Config schema and no build step: the page owns every editable value, and
 *   paths come from the plain config object handed to `apply`.
 * - Config writes go through `configEditor` when the profile provides it
 *   (validated, applied immediately, comments preserved); the provider route
 *   keeps a line-level fallback so a headless host still works.
 */
import { execFile, spawn } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createServer, request as httpRequest } from 'node:http'
import { createLocalWorker, hybridPromptText, resolveFfmpeg } from './lib/hybrid.js'
import { MODELS, defaultSettingsFor, modelById, pickModelFields } from './lib/models.js'

export const name = 'dsh-local-llm'

const ROUTE_PREFIX = '/local-llm'

/** Bumped whenever the host half changes in a way a reload must pick up. */
const BUILD = 11

/** Per-model fields; the active model's copy is mirrored flat onto `settings`. */
const MODEL_FIELDS = [
  'port',
  'contextSize',
  'threads',
  'vision',
  'thinking',
  'reasoningBudget',
  'reasoningPreserve',
  'modelFile',
  'mmprojFile',
  'temperature',
]

/** Global (cross-model) values the Settings page may edit. */
const EDITABLE = [
  'compactionThresholdRatio',
  'compactionRetainTokens',
  'summarizationProvider',
  'summarizationModel',
  'proxyEnabled',
  'proxyPort',
  'routeViaProxy',
  'hybridEnabled',
  'hybridOnlineProvider',
  'hybridOnlineModel',
  'choreText',
  'choreImage',
  'choreVideo',
  'localTimeoutMs',
  'choreMaxInputChars',
  'choreMaxOutputTokens',
  'videoFrames',
  'ffmpegPath',
  'autoStartLocal',
  'installDir',
  'exePath',
  'modelsDir',
  'logsDir',
]

const DEFAULTS = {
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
  localTimeoutMs: 120000,
  choreMaxInputChars: 24000,
  choreMaxOutputTokens: 1024,
  videoFrames: 3,
  ffmpegPath: '',
  autoStartLocal: false,
  // Deployment paths; empty means "derive from installDir".
  installDir: 'D:\\local-llm',
  exePath: '',
  modelsDir: '',
  logsDir: '',
}

const LAUNCH = { gpuLayers: 99, parallel: 1 }

/**
 * Normalize a stored settings object into the current shape: `activeModel`,
 * a `profiles` entry per model, and the active profile mirrored flat so the rest
 * of the runtime can keep reading `settings.port`-style fields.
 */
export function migrateSettings(raw) {
  const settings = { ...DEFAULTS, ...(raw ?? {}) }

  const legacy = {}
  for (const key of MODEL_FIELDS) {
    if (settings[key] !== undefined) legacy[key] = settings[key]
  }

  const stored = settings.profiles
  const hasProfiles = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
  settings.profiles = {}
  for (const profile of MODELS) {
    const base = defaultSettingsFor(profile)
    if (hasProfiles && stored[profile.id] !== undefined) {
      settings.profiles[profile.id] = { ...base, ...stored[profile.id] }
    } else if (!hasProfiles && profile.id === 'qwen') {
      // Pre-multi-model state: the flat fields were the Qwen settings.
      settings.profiles[profile.id] = { ...base, ...legacy }
    } else {
      settings.profiles[profile.id] = base
    }
  }

  settings.activeModel = modelById(settings.activeModel).id
  for (const key of MODEL_FIELDS) delete settings[key]
  Object.assign(settings, settings.profiles[settings.activeModel])
  return settings
}

const LIMITS = {
  port: [1024, 65535],
  contextSize: [512, 262144],
  threads: [1, 64],
  reasoningBudget: [0, 16384],
  compactionThresholdRatio: [0.3, 0.9],
  compactionRetainTokens: [1024, 65536],
  proxyPort: [1024, 65535],
  localTimeoutMs: [5000, 600000],
  choreMaxInputChars: [1000, 100000],
  choreMaxOutputTokens: [64, 4096],
  videoFrames: [1, 6],
  temperature: [0, 2],
}

/** Requests kept for inspection; enough to see one turn, small enough to poll. */
const CAPTURE_LIMIT = 12
/** Largest request the proxy will buffer for forwarding. */
const CAPTURE_MAX_BYTES = 32 * 1024 * 1024
/** Largest response kept for a non-streaming call, to read `usage` from. */
const CAPTURE_RESPONSE_BYTES = 64 * 1024

/** The route this plugin owns, as declared by the profile's `llm-pi-ai` row. */
const ROUTE = { provider: 'local-qwen', model: 'qwen3.5-4b', name: '本地 Qwen3.5 4B' }

/** Summary output cap written into the local model's compaction policy. */
const SUMMARY_MAX_TOKENS = 2048

/**
 * Tokens every request re-sends before its message history: the tool schemas
 * plus the system prompt. Measured from a real `request/header` (36,959 bytes of
 * tool JSON ≈ 10.5K tokens) with room for the assembled system prompt.
 * The compaction trigger must leave this much free, or the summarization
 * request itself overflows the window — the failure this plugin fixes.
 */
const PROMPT_OVERHEAD_TOKENS = 16384

// ---------------------------------------------------------------------------
// derived numbers (pure; covered by the offline route test)
// ---------------------------------------------------------------------------

/**
 * Output cap for one request, derived from the configured window.
 * `ctx/8`, never below 8192 and never above 32768 or half the window.
 */
export function maxTokensFor(contextSize) {
  const derived = Math.round(contextSize / 8)
  const upper = Math.min(32768, Math.floor(contextSize / 2))
  return Math.max(8192, Math.min(derived, upper))
}

/**
 * The compaction policy for the local route, derived from the configured window.
 *
 * llama's defaults (`thresholdRatio 0.8`, `headroomTokens 65536`) assume a large
 * window: with W=32768 and O=8192 they resolve the trigger to
 * `min(26214, -40960)`, i.e. negative, so every step tries to condense and the
 * summary request re-sends a prefix that no longer fits. A per-model policy with
 * zero headroom and an explicit summary cap fixes both ends of that arithmetic.
 */
export function compactionPolicyFor(settings, profile = MODELS[0]) {
  const contextSize = settings.contextSize
  const ratio = settings.compactionThresholdRatio
  const ceiling = contextSize - PROMPT_OVERHEAD_TOKENS - SUMMARY_MAX_TOKENS - 1024
  const threshold = Math.min(Math.floor(contextSize * ratio), ceiling)
  const retainTokens = Math.min(settings.compactionRetainTokens, threshold - SUMMARY_MAX_TOKENS - 1024)
  const viable = threshold > 4096 && retainTokens >= 1024

  const policy = {
    provider: profile.provider,
    model: profile.model,
    thresholdRatio: ratio,
    headroomTokens: 0,
    retainTokens: Math.max(1024, retainTokens),
    maxTokens: SUMMARY_MAX_TOKENS,
  }
  if (settings.summarizationProvider !== '' && settings.summarizationModel !== '') {
    policy.summarizationProvider = settings.summarizationProvider
    policy.summarizationModel = settings.summarizationModel
  }

  const derived = {
    threshold: Math.max(0, threshold),
    retainTokens: Math.max(0, retainTokens),
    summaryCap: SUMMARY_MAX_TOKENS,
    ceiling,
    overhead: PROMPT_OVERHEAD_TOKENS,
    viable,
    reason: viable
      ? null
      : `上下文 ${contextSize} 太小：压缩触发点算出来只有 ${Math.max(0, threshold)} token，`
        + `连固定开销 ${PROMPT_OVERHEAD_TOKENS} + 摘要 ${SUMMARY_MAX_TOKENS} 都放不下。建议 ≥ 65536。`,
  }

  return { policy, derived }
}

/**
 * Assemble llama-server arguments for one model profile. Pure so the tests can
 * prove each model's flag set without paying for a model load. `help === null`
 * means the `--help` probe failed; the historically known flags are then assumed,
 * but the reasoning-preserve pair is only passed when the build advertises it (an
 * unknown flag would abort startup).
 */
export function buildLaunchArgs(values, help, modelsDir, profile = MODELS[0]) {
  const supported = (flag) => (help === null ? true : help.includes(flag))
  const flags = profile.flags ?? {}
  const args = [
    '--model', join(modelsDir, values.modelFile),
    '--alias', profile.alias,
    '--host', '127.0.0.1',
    '--port', String(values.port),
    '--ctx-size', String(values.contextSize),
    '--n-gpu-layers', String(LAUNCH.gpuLayers),
    '--threads', String(values.threads),
  ]
  if (supported('--flash-attn')) args.push('--flash-attn', 'on')
  if (supported('--jinja')) args.push('--jinja')
  if (flags.metrics === true && supported('--metrics')) args.push('--metrics')
  // Always explicit: omitting the flag makes llama.cpp choose `auto`, which on
  // this build means four slots — extra sequence state and compute buffers that
  // this 8 GB card cannot spare.
  if (supported('--parallel')) args.push('--parallel', String(LAUNCH.parallel))

  if (values.vision) {
    args.push('--mmproj', join(modelsDir, values.mmprojFile))
    if (flags.imageMinTokens === true && supported('--image-min-tokens')) {
      args.push('--image-min-tokens', '1024')
    }
  }

  if (flags.temperature === true) {
    if (supported('--temp')) args.push('--temp', String(values.temperature ?? 0))
  }
  if (flags.webui === false && supported('--no-webui')) args.push('--no-webui')
  if (flags.videoFfmpeg === true && profile.videoFfmpegDir !== undefined
    && supported('--video-ffmpeg-dir')) {
    args.push('--video-ffmpeg-dir', profile.videoFfmpegDir)
  }

  // Thinking: a positive budget keeps thinking but caps it, so the answer still
  // has room inside the output cap. A zero budget means "do not think".
  const budget = values.reasoningBudget ?? 0
  const thinkingOn = values.thinking === true && budget > 0
  if (flags.thinking === true) {
    if (thinkingOn) {
      if (supported('--reasoning')) args.push('--reasoning', 'on')
      if (supported('--reasoning-budget')) args.push('--reasoning-budget', String(budget))
      // `deepseek` moves thoughts into message.reasoning_content; `none` would
      // leave them inline in content, where they also confuse tool-call parsing.
      if (supported('--reasoning-format')) args.push('--reasoning-format', 'deepseek')
    } else {
      if (supported('--reasoning')) args.push('--reasoning', 'off')
      else if (supported('--reasoning-budget')) args.push('--reasoning-budget', '0')
      else if (supported('--chat-template-kwargs')) {
        args.push('--chat-template-kwargs', '{"enable_thinking":false}')
      }
    }

    // Always explicit when supported: llama enables reasoning preservation by
    // default, which re-feeds every earlier turn's thoughts into the next prompt.
    if (help !== null && help.includes('--reasoning-preserve')) {
      args.push(values.reasoningPreserve === true ? '--reasoning-preserve' : '--no-reasoning-preserve')
    }
  } else if (flags.thinking !== true && supported('--reasoning')) {
    // Templates without a thinking toggle still accept the server-side switch.
    args.push('--reasoning', 'off')
  }
  return args
}

const THINK_TAG = /<think>/gi

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * Describe what one chat request actually carries. This is the measurement the
 * plugin could not make from a session log: whether assistant history arrives as
 * a `reasoning_content` field, as inline `<think>` text, or not at all, and how
 * much of the prompt is tool schemas versus tool output.
 */
export function analyzeChatRequest(body, bytes) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const byRole = {}
  let textChars = 0
  let toolChars = 0
  let reasoningFieldChars = 0
  let inlineThinkChars = 0
  let imageCount = 0

  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : '?'
    byRole[role] = (byRole[role] ?? 0) + 1
    const text = contentText(message?.content)
    textChars += text.length
    if (role === 'tool') toolChars += text.length
    if (typeof message?.reasoning_content === 'string') reasoningFieldChars += message.reasoning_content.length
    inlineThinkChars += (text.match(THINK_TAG) ?? []).length
    if (Array.isArray(message?.content)) {
      imageCount += message.content.filter((part) => part?.type === 'image_url' || part?.type === 'image').length
    }
  }

  return {
    messages: messages.length,
    byRole,
    textChars,
    toolChars,
    reasoningFieldChars,
    inlineThinkBlocks: inlineThinkChars,
    imageCount,
    toolsBytes: Array.isArray(body?.tools) ? JSON.stringify(body.tools).length : 0,
    maxTokens: typeof body?.max_tokens === 'number' ? body.max_tokens : null,
    stream: body?.stream === true,
    bytes,
  }
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(path, fallback) {
  const text = readText(path)
  if (text === undefined) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Run a command without ever throwing; returns captured stdio. */
function runFile(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: options.timeout ?? 15000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          code: error?.code ?? 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          message: error?.message ?? '',
        })
      },
    )
  })
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Last `lines` lines of a file, read from the tail so big logs stay cheap. */
function tailLines(path, lines = 20) {
  let size
  try {
    size = statSync(path).size
  } catch {
    return []
  }
  if (size === 0) return []
  const span = Math.min(size, 16 * 1024)
  let text = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(span)
      const read = readSync(fd, buffer, 0, span, size - span)
      text = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-lines)
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

/**
 * Build the process-control runtime for one plugin instance.
 * @param ctx - the plugin context (used only for logging).
 * @param config - the Loader entry config (paths + defaults).
 */
function createRuntime(ctx, config) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const statePath = join(home, 'data', 'dsh-local-llm', 'state.json')

  const stored = readJson(statePath, {})
  let settings = migrateSettings({ ...DEFAULTS, ...(stored.settings ?? {}) })
  /** Snapshot of the settings the *running* process was launched with. */
  let launch = stored.launch ?? null

  // Paths follow the active model, so they are refreshed instead of being fixed.
  let exePath = ''
  let modelsDir = ''
  let logsDir = ''
  let outLog = ''
  let errLog = ''
  let pidPath = ''
  let helpCache

  function activeProfile() {
    return modelById(settings.activeModel)
  }

  /** Model descriptor the page renders its selector and fields from. */
  function target() {
    const profile = activeProfile()
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      model: profile.model,
      alias: profile.alias,
      fields: profile.fields,
      flags: profile.flags,
      strength: profile.strength,
      installDir: profile.installDir,
      logsDir: profile.logsDir,
      paths: resolvePaths(),
    }
  }

  /**
   * Resolve the four deployment paths. Empty values fall back to the profile's
   * defaults, so a standard install needs no configuration and a relocated one
   * only overrides what differs.
   */
  function resolvePaths() {
    const profile = activeProfile()
    const pick = (value) => (typeof value === 'string' ? value.trim() : '')
    const root = pick(settings.installDir) !== '' ? pick(settings.installDir) : profile.installDir
    const exe = pick(settings.exePath) !== '' ? pick(settings.exePath) : join(root, profile.exeRel)
    const models = pick(settings.modelsDir) !== '' ? pick(settings.modelsDir) : join(root, 'models')
    const logs = pick(settings.logsDir) !== '' ? pick(settings.logsDir) : join(root, 'logs')
    return { root, exe, models, logs }
  }

  function refreshPaths() {
    const resolved = resolvePaths()
    exePath = resolved.exe
    modelsDir = resolved.models
    logsDir = resolved.logs
    outLog = join(logsDir, 'server.out.log')
    errLog = join(logsDir, 'server.err.log')
    pidPath = join(logsDir, 'server.pid')
    helpCache = undefined
  }

  refreshPaths()

  let child = null
  let phase = 'idle' // idle | starting | ready | stopped | failed
  let stopIntent = false
  let error = null

  // --- persistence ---------------------------------------------------------

  function persist() {
    writeJson(statePath, { settings, launch })
  }

  if (launch?.settings === undefined) launch = null

  // --- probes --------------------------------------------------------------

  async function health(port = settings.port, timeoutMs = 1500) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
        cache: 'no-store',
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async function vram() {
    const result = await runFile('nvidia-smi', [
      '--query-gpu=memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ], { timeout: 4000 })
    if (!result.ok) return null
    const first = result.stdout.trim().split(/\r?\n/)[0]
    if (!first) return null
    const [used, total] = first.split(',').map((part) => Number(part.trim()))
    if (!Number.isFinite(used) || !Number.isFinite(total)) return null
    return { usedMiB: used, totalMiB: total }
  }

  async function portOwner(port) {
    const result = await runFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 10000 })
    if (!result.stdout) return null
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const columns = line.trim().split(/\s+/)
      if (columns.length < 5) continue
      if (!columns[1].endsWith(`:${port}`)) continue
      const candidate = Number(columns[columns.length - 1])
      if (Number.isInteger(candidate) && candidate > 0) return candidate
    }
    return null
  }

  async function processName(pid) {
    const result = await runFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      timeout: 8000,
    })
    const match = /^"([^"]+)"/.exec(result.stdout.trim())
    return match ? match[1] : null
  }

  /** Kill a process tree, but never a PID that has been recycled by something else. */
  async function killNode(pid) {
    if (!isAlive(pid)) return { ok: true, skipped: '已退出' }
    const image = await processName(pid)
    if (image === null) return { ok: false, error: `找不到 PID ${pid} 的进程信息` }
    if (!/llama/i.test(image)) {
      return { ok: false, error: `PID ${pid} 现在是 ${image}，不是 llama-server，已跳过（PID 复用保护）` }
    }
    const result = await runFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000 })
    if (!result.ok && isAlive(pid)) {
      return { ok: false, error: result.stderr.trim() || result.message || 'taskkill 失败' }
    }
    return { ok: true }
  }

  // --- launch arguments ----------------------------------------------------

  async function helpText() {
    if (helpCache !== undefined) return helpCache
    if (!existsSync(exePath)) {
      helpCache = null
      return helpCache
    }
    const result = await runFile(exePath, ['--help'], { timeout: 25000, maxBuffer: 4 * 1024 * 1024 })
    const text = `${result.stdout}\n${result.stderr}`
    helpCache = text.trim() !== '' ? text : null
    return helpCache
  }

  /** `null` help means the probe failed: assume the flags the shipped script used. */
  function buildArgs(values, help) {
    return buildLaunchArgs(values, help, modelsDir, activeProfile())
  }

  // --- model discovery -----------------------------------------------------

  function listModels(extension) {
    if (!existsSync(modelsDir)) return []
    try {
      return readdirSync(modelsDir)
        .filter((file) => file.toLowerCase().endsWith(extension))
        .filter((file) => {
          try {
            return statSync(join(modelsDir, file)).isFile()
          } catch {
            return false
          }
        })
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  function modelFiles() {
    return listModels('.gguf').filter((file) => !/^mmproj/i.test(file))
  }

  function mmprojFiles() {
    return listModels('.gguf').filter((file) => /^mmproj/i.test(file))
  }

  // --- profile route -------------------------------------------------------

  function profilePatchPath() {
    const dir = process.env.DSH_PROFILE_DIR
    if (typeof dir !== 'string' || dir === '') return null
    const path = join(dir, 'cordis.patch.yml')
    return existsSync(path) ? path : null
  }

  /**
   * One provider's block in the profile patch, found as a YAML key and bounded by
   * the next line with equal-or-smaller indentation. Splitting into line arrays
   * keeps the rewrite comment-preserving without index arithmetic.
   */
  function routeBlock(text, provider) {
    const lines = text.split('\n')
    const key = new RegExp(`^(\\s*)${provider}:\\s*$`)
    let startLine = -1
    let indent = 0
    for (let index = 0; index < lines.length; index += 1) {
      const match = key.exec(lines[index])
      if (match !== null) {
        startLine = index
        indent = match[1].length
        break
      }
    }
    if (startLine < 0) return null
    let endLine = lines.length
    for (let index = startLine + 1; index < lines.length; index += 1) {
      if (lines[index].trim() === '') continue
      const lineIndent = lines[index].length - lines[index].trimStart().length
      if (lineIndent <= indent) {
        endLine = index
        break
      }
    }
    return {
      before: lines.slice(0, startLine),
      body: lines.slice(startLine, endLine),
      after: lines.slice(endLine),
    }
  }

  /** The provider numbers the harness actually budgets with, read from the patch text. */
  function routeInfo(provider = activeProfile().provider) {
    const path = profilePatchPath()
    const empty = { path, baseUrl: null, port: null, contextWindow: null, maxTokens: null }
    if (path === null) return empty
    const block = routeBlock(readText(path) ?? '', provider)
    if (block === null) return empty
    const text = block.body.join('\n')
    const base = /baseURL:\s*(http:\/\/127\.0\.0\.1:(\d+)\/v1)/.exec(text)
    const context = /contextWindow:\s*(\d+)/.exec(text)
    const max = /maxTokens:\s*(\d+)/.exec(text)
    return {
      path,
      baseUrl: base === null ? null : base[1],
      port: base === null ? null : Number(base[2]),
      contextWindow: context === null ? null : Number(context[1]),
      maxTokens: max === null ? null : Number(max[1]),
    }
  }

  /**
   * Line-level fallback writer. It keeps every comment and the file layout intact,
   * which a YAML round-trip would destroy; it is only used when the profile has no
   * `configEditor` (headless hosts).
   */
  function syncRouteText(target) {
    const path = profilePatchPath()
    const fail = (reason) => ({ updated: false, fields: [], live: false, via: 'file', reason })
    if (path === null) return fail('没有找到 profile 的 cordis.patch.yml')
    const text = readText(path)
    if (text === undefined) return fail('读取 cordis.patch.yml 失败')
    const block = routeBlock(text, target.provider)
    if (block === null) return fail(`cordis.patch.yml 里没有 ${target.provider} 路由`)

    const fields = []
    const setNumber = (key, value, label) => {
      const pattern = new RegExp(`^(\\s*${key}:\\s*)(\\d+)\\s*$`)
      for (let index = 0; index < block.body.length; index += 1) {
        const match = pattern.exec(block.body[index])
        if (match === null) continue
        if (Number(match[2]) === value) return
        block.body[index] = `${match[1]}${value}`
        fields.push(label)
        return
      }
    }

    setNumber('contextWindow', target.contextWindow, 'contextWindow')
    setNumber('maxTokens', target.maxTokens, 'maxTokens')
    const port = new URL(target.baseURL).port
    for (let index = 0; index < block.body.length; index += 1) {
      const match = /^(\s*baseURL:\s*http:\/\/127\.0\.0\.1:)(\d+)(\/v1\s*)$/.exec(block.body[index])
      if (match === null) continue
      if (Number(match[2]) !== Number(port)) {
        block.body[index] = `${match[1]}${port}${match[3]}`
        fields.push('baseURL')
      }
      break
    }

    if (fields.length === 0) return { updated: false, fields, live: false, via: 'file', reason: null }
    try {
      copyFileSync(path, `${path}.bak`)
      writeFileSync(path, [...block.before, ...block.body, ...block.after].join('\n'), 'utf8')
    } catch (cause) {
      return fail(`写入失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return { updated: true, fields, live: false, via: 'file', reason: null }
  }

  // --- config writes -------------------------------------------------------

  function configEditor() {
    return ctx.get('configEditor')
  }

  function entryId(entry) {
    return typeof entry?.id === 'string' ? entry.id : ''
  }

  /** Readable row name for the page (`include:preset-standard` → `preset-standard`). */
  function displayId(entry) {
    return entryId(entry).replace(/^include:/, '')
  }

  /**
   * One detached read of every addressable row. Row ids and `name` differ between
   * hosts (this one prefixes ids with `include:` and leaves `name` undefined), so
   * rows are matched by content instead: the route row owns
   * `providers['local-qwen']`, a preset row mounts `compaction-basic`.
   */
  function editorSnapshot(editor) {
    return editor.configuration().map((row) => ({
      entry: row.entry,
      merged: { ...(row.inherited ?? {}), ...(row.override ?? {}) },
    }))
  }

  function routeRow(snapshot, profile = activeProfile()) {
    for (const row of snapshot) {
      const route = row.merged?.providers?.[profile.provider]
      if (route === null || typeof route !== 'object' || !Array.isArray(route.models)) continue
      if (!route.models.some((candidate) => candidate?.id === profile.model)) continue
      return row
    }
    return null
  }

  function compactionRows(snapshot) {
    return snapshot
      .map((row) => ({ row, nodes: findCompactionNodes(row.merged ?? {}) }))
      .filter((item) => item.nodes.length > 0)
  }

  function providerValues(editor, profile = activeProfile()) {
    const fromFile = () => {
      const route = routeInfo(profile.provider)
      return {
        source: 'file',
        baseUrl: route.baseUrl,
        contextWindow: route.contextWindow,
        maxTokens: route.maxTokens,
      }
    }
    if (editor === undefined) return fromFile()
    try {
      const row = routeRow(editorSnapshot(editor), profile)
      if (row === null) throw new Error(`没有找到 ${profile.provider} 路由行`)
      const route = row.merged.providers[profile.provider]
      const model = route.models.find((candidate) => candidate?.id === profile.model)
      return {
        source: 'configEditor',
        baseUrl: typeof route.baseURL === 'string' ? route.baseURL : null,
        contextWindow: typeof model?.contextWindow === 'number' ? model.contextWindow : null,
        maxTokens: typeof model?.maxTokens === 'number' ? model.maxTokens : null,
      }
    } catch {
      return fromFile()
    }
  }

  /** Settings of any model, whether or not it is the active one. */
  function settingsFor(modelId) {
    const profile = modelById(modelId)
    if (modelId === settings.activeModel) return settings
    return { ...defaultSettingsFor(profile), ...(settings.profiles[modelId] ?? {}) }
  }

  /**
   * Keep one provider route's port and capacity numbers equal to that model's
   * settings. `contextWindow` and `maxTokens` are not decoration: they are the
   * window and output budget the agent loop and the compactor reason about.
   */
  async function syncProviderConfig(modelId = settings.activeModel) {
    const profile = modelById(modelId)
    const values = settingsFor(profile.id)
    const target = {
      provider: profile.provider,
      model: profile.model,
      // The route points either straight at llama-server or at the capture proxy,
      // which forwards to it. Both are stable local URLs.
      baseURL: settings.routeViaProxy === true
        ? `http://127.0.0.1:${settings.proxyPort}/v1`
        : `http://127.0.0.1:${values.port}/v1`,
      contextWindow: values.contextSize,
      maxTokens: maxTokensFor(values.contextSize),
    }
    const editor = configEditor()
    if (editor === undefined) return syncRouteText(target)

    const before = providerValues(editor, profile)
    if (before.source === 'configEditor'
      && before.baseUrl === target.baseURL
      && before.contextWindow === target.contextWindow
      && before.maxTokens === target.maxTokens) {
      return { updated: false, fields: [], live: true, via: 'configEditor', reason: null }
    }

    try {
      const row = routeRow(editorSnapshot(editor), profile)
      if (row === null) throw new Error(`没有找到 ${profile.provider} 路由行`)
      const entry = row.entry
      const fields = []
      await editor.edit(entry, (current, inherited) => {
        const merged = { ...(inherited ?? {}), ...(current ?? {}) }
        const providers = structuredClone(merged.providers ?? {})
        const route = providers[profile.provider]
        if (route === null || typeof route !== 'object' || !Array.isArray(route.models)) {
          throw new Error(`providers.${profile.provider} 结构不符合预期，未写入`)
        }
        const index = route.models.findIndex((candidate) => candidate?.id === profile.model)
        if (index < 0) throw new Error(`模型 ${profile.model} 不在路由里，未写入`)
        fields.length = 0
        if (route.baseURL !== target.baseURL) {
          route.baseURL = target.baseURL
          fields.push('baseURL')
        }
        const model = { ...route.models[index] }
        if (model.contextWindow !== target.contextWindow) {
          model.contextWindow = target.contextWindow
          fields.push('contextWindow')
        }
        if (model.maxTokens !== target.maxTokens) {
          model.maxTokens = target.maxTokens
          fields.push('maxTokens')
        }
        route.models[index] = model
        providers[profile.provider] = route
        return { ...merged, providers }
      })
      return { updated: fields.length > 0, fields, live: true, via: 'configEditor', reason: null, model: profile.id }
    } catch (cause) {
      const fallback = syncRouteText(target)
      return {
        ...fallback,
        model: profile.id,
        reason: fallback.reason ?? (cause instanceof Error ? cause.message : String(cause)),
      }
    }
  }

  /** Every object in a preset tree that mounts `compaction-basic`. */
  function findCompactionNodes(node, out = []) {
    if (Array.isArray(node)) {
      for (const child of node) findCompactionNodes(child, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    if (node.id === 'compaction-basic') out.push(node)
    if (Array.isArray(node.config)) findCompactionNodes(node.config, out)
    if (Array.isArray(node.plugins)) findCompactionNodes(node.plugins, out)
    return out
  }

  /** Policy keys this plugin owns; a stale value must not survive a rewrite. */
  const POLICY_KEYS = [
    'thresholdRatio',
    'headroomTokens',
    'retainRatio',
    'retainTokens',
    'maxTokens',
    'summarizationProvider',
    'summarizationModel',
  ]

  function withLocalPolicy(policies, policy) {
    const list = Array.isArray(policies) ? structuredClone(policies) : []
    const index = list.findIndex((candidate) => candidate?.provider === policy.provider
      && candidate?.model === policy.model)
    if (index >= 0) {
      // Replace, do not merge: a cleared summarization target has to disappear,
      // and every other key here is recomputed from the current window anyway.
      const kept = { ...list[index] }
      for (const key of POLICY_KEYS) delete kept[key]
      list[index] = { ...kept, ...policy }
    } else {
      list.push(policy)
    }
    return list
  }

  function policyMatches(node, policy) {
    const list = Array.isArray(node?.config?.modelPolicies) ? node.config.modelPolicies : []
    const current = list.find((candidate) => candidate?.provider === policy.provider
      && candidate?.model === policy.model)
    if (current === undefined) return false
    return ['thresholdRatio', 'headroomTokens', 'retainTokens', 'maxTokens'].every(
      (key) => current[key] === policy[key],
    ) && (current.summarizationProvider ?? '') === (policy.summarizationProvider ?? '')
      && (current.summarizationModel ?? '') === (policy.summarizationModel ?? '')
  }

  /** Where each preset stands relative to the desired local policy. */
  /** Desired compaction policies, one per model, computed from each window. */
  function compactionPlans() {
    return MODELS.map((profile) => {
      const values = settingsFor(profile.id)
      const { policy, derived } = compactionPolicyFor({
        ...values,
        compactionThresholdRatio: settings.compactionThresholdRatio,
        compactionRetainTokens: settings.compactionRetainTokens,
        summarizationProvider: settings.summarizationProvider,
        summarizationModel: settings.summarizationModel,
      }, profile)
      return { profile, policy, derived }
    })
  }

  function compactionState(editor) {
    const plans = compactionPlans()
    const active = plans.find((plan) => plan.profile.id === settings.activeModel) ?? plans[0]
    if (editor === undefined) {
      return {
        policy: active.policy,
        derived: active.derived,
        policies: plans.map((plan) => ({ model: plan.profile.id, derived: plan.derived })),
        presets: [],
        available: false,
        drift: ['configEditor 不可用'],
      }
    }
    const presets = []
    const drift = []
    for (const { row, nodes } of compactionRows(editorSnapshot(editor))) {
      const applied = plans.every((plan) => plan.derived.viable !== true
        || nodes.every((node) => policyMatches(node, plan.policy)))
      const id = displayId(row.entry)
      presets.push({ id, applied })
      if (!applied) drift.push(`预设 ${id} 的本地压缩策略未同步`)
    }
    return {
      policy: active.policy,
      derived: active.derived,
      policies: plans.map((plan) => ({ model: plan.profile.id, threshold: plan.derived.threshold, viable: plan.derived.viable })),
      presets,
      available: true,
      drift,
    }
  }

  /**
   * Write one compaction policy per model into every preset that mounts
   * `compaction-basic`, leaving other models' policies and global defaults alone.
   */
  async function syncCompactionPolicy() {
    const allPlans = compactionPlans()
    const plans = allPlans.filter((plan) => plan.derived.viable === true)
    const skipped = allPlans
      .filter((plan) => plan.derived.viable !== true)
      .map((plan) => ({ model: plan.profile.id, reason: plan.derived.reason }))
    if (plans.length === 0) {
      const active = allPlans.find((plan) => plan.profile.id === settings.activeModel)
      return {
        ok: false,
        updated: false,
        live: false,
        presets: [],
        skipped,
        reason: active?.derived.reason ?? skipped[0]?.reason ?? null,
      }
    }
    const editor = configEditor()
    if (editor === undefined) {
      return {
        ok: false,
        updated: false,
        live: false,
        presets: [],
        reason: 'configEditor 不可用（headless 或无 profile）：压缩策略需要手动写入 agent 预设',
      }
    }

    const results = []
    for (const { row, nodes } of compactionRows(editorSnapshot(editor))) {
      const entry = row.entry
      const id = displayId(entry)

      if (plans.every((plan) => nodes.every((node) => policyMatches(node, plan.policy)))) {
        results.push({ id, updated: false })
        continue
      }

      try {
        await editor.edit(entry, (current, inherited) => {
          const next = structuredClone({ ...(inherited ?? {}), ...(current ?? {}) })
          const targets = findCompactionNodes(next)
          if (targets.length === 0) throw new Error('预设里没有 compaction-basic')
          for (const node of targets) {
            const known = new Set(MODELS.map((entry) => entry.provider))
            // Drop policies for local routes this plugin no longer serves (the
            // removed models), keep every foreign policy untouched.
            const existing = Array.isArray(node.config?.modelPolicies)
              ? node.config.modelPolicies.filter((policy) => !(
                typeof policy?.provider === 'string'
                && policy.provider.startsWith('local-')
                && !known.has(policy.provider)))
              : node.config?.modelPolicies
            let policies = existing
            for (const plan of plans) policies = withLocalPolicy(policies, plan.policy)
            node.config = {
              ...(node.config ?? {}),
              auto: settings.compactionEnabled !== false,
              modelPolicies: policies,
            }
          }
          return next
        })
        results.push({ id, updated: true })
      } catch (cause) {
        results.push({
          id,
          updated: false,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }

    if (results.length === 0) {
      return {
        ok: false,
        updated: false,
        live: false,
        presets: [],
        reason: '没有找到挂载 compaction-basic 的 agent 预设',
      }
    }
    const failures = results.filter((result) => result.error !== undefined)
    return {
      ok: failures.length === 0,
      updated: results.some((result) => result.updated),
      live: true,
      presets: results,
      skipped,
      reason: failures.length === 0 ? null : failures.map((result) => `${result.id}: ${result.error}`).join('；'),
    }
  }

  // --- summarization choices ----------------------------------------------

  let choiceCache = { at: 0, value: null, loading: null }

  /**
   * Models a compaction summary could target. `llm.listModels` is async (pi-ai may
   * interrogate the endpoint), so this awaits it, caches the result, and bounds
   * each provider: a slow or credential-less provider must not stall the page.
   */
  async function summarizationChoices() {
    if (choiceCache.value !== null && Date.now() - choiceCache.at < 60_000) return choiceCache.value
    if (choiceCache.loading !== null) return choiceCache.loading

    const llm = ctx.get('llm')
    if (llm === undefined) return []
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    if (!Array.isArray(providers) || providers.length === 0) return []

    const load = (async () => {
      const choices = []
      for (const provider of providers) {
        try {
          const models = await Promise.race([
            Promise.resolve(llm.listModels(provider.id)),
            new Promise((resolve) => {
              setTimeout(() => resolve(null), 3000)
            }),
          ])
          if (!Array.isArray(models) || models.length === 0) continue
          choices.push({
            provider: provider.id,
            name: provider.name ?? provider.id,
            models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
          })
        } catch {
          // A provider that cannot enumerate its catalog simply is not offered.
        }
      }
      return choices
    })()

    choiceCache.loading = load
    const value = await load
    choiceCache = { at: Date.now(), value, loading: null }
    return value
  }

  // --- capture proxy -------------------------------------------------------

  const proxy = { server: null, listening: false, error: null, captures: [] }

  function proxyUrl() {
    return `http://127.0.0.1:${settings.proxyPort}/v1`
  }

  function directUrl() {
    return `http://127.0.0.1:${settings.port}/v1`
  }

  function recordCapture(entry) {
    proxy.captures.push(entry)
    while (proxy.captures.length > CAPTURE_LIMIT) proxy.captures.shift()
  }

  /** Drop hop-by-hop headers; the body is re-sent by Node with its own framing. */
  function forwardHeaders(headers) {
    const next = { ...headers }
    delete next.host
    delete next['content-length']
    delete next.connection
    return next
  }

  /**
   * Transparent reverse proxy in front of llama-server. It forwards bytes
   * untouched (SSE included) and records what the request actually carried, which
   * is the only way to see how the harness serializes history for this model.
   */
  function handleProxyRequest(request, response) {
    const startedAt = Date.now()
    const chunks = []
    let size = 0

    request.on('data', (chunk) => {
      size += chunk.length
      // Keep buffering until the cap so the request can still be forwarded; the
      // cap only bounds memory, and an oversized body is refused below.
      chunks.push(chunk)
    })

    request.on('end', () => {
      if (size > CAPTURE_MAX_BYTES) {
        response.writeHead(413, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: `proxy: request larger than ${CAPTURE_MAX_BYTES} bytes` }))
        return
      }

      const body = Buffer.concat(chunks)
      let parsed = null
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        parsed = null
      }
      const record = {
        at: startedAt,
        path: request.url ?? '',
        status: 0,
        ms: 0,
        error: null,
        summary: parsed === null ? { bytes: size, messages: null } : analyzeChatRequest(parsed, size),
      }
      recordCapture(record)

      const upstream = httpRequest({
        host: '127.0.0.1',
        port: settings.port,
        path: request.url,
        method: request.method,
        headers: forwardHeaders(request.headers),
      }, (upstreamResponse) => {
        record.status = upstreamResponse.statusCode ?? 0
        const headers = { ...upstreamResponse.headers }
        delete headers.connection
        delete headers['transfer-encoding']
        delete headers['content-length']

        const isJson = String(upstreamResponse.headers['content-type'] ?? '').includes('application/json')
        const kept = isJson ? [] : null
        let bytes = 0

        response.writeHead(record.status, headers)
        upstreamResponse.on('data', (chunk) => {
          bytes += chunk.length
          if (kept !== null && bytes < CAPTURE_RESPONSE_BYTES) kept.push(chunk)
          response.write(chunk)
        })
        upstreamResponse.on('end', () => {
          record.ms = Date.now() - startedAt
          record.responseBytes = bytes
          if (kept !== null) {
            try {
              const json = JSON.parse(Buffer.concat(kept).toString('utf8'))
              if (json?.usage !== undefined) record.usage = json.usage
            } catch {
              // A truncated or non-JSON reply simply carries no usage.
            }
          }
          response.end()
        })
      })

      upstream.on('error', (cause) => {
        record.status = 502
        record.ms = Date.now() - startedAt
        record.error = cause instanceof Error ? cause.message : String(cause)
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: `proxy: ${record.error}` }))
        } else {
          response.end()
        }
      })

      response.on('close', () => {
        if (!upstream.destroyed) upstream.destroy()
      })

      upstream.end(body)
    })

    request.on('error', () => {
      response.destroy()
    })
  }

  function stopProxy() {
    if (proxy.server !== null) {
      try {
        proxy.server.close()
      } catch {
        // Already closed.
      }
      proxy.server = null
    }
    proxy.listening = false
  }

  function startProxy() {
    stopProxy()
    proxy.error = null
    if (settings.proxyEnabled !== true) return
    const server = createServer(handleProxyRequest)
    server.on('error', (cause) => {
      proxy.listening = false
      proxy.error = cause instanceof Error ? cause.message : String(cause)
    })
    server.listen(settings.proxyPort, '127.0.0.1', () => {
      proxy.listening = true
      proxy.error = null
    })
    proxy.server = server
  }

  function proxyStatus() {
    return {
      enabled: settings.proxyEnabled === true,
      port: settings.proxyPort,
      listening: proxy.listening,
      error: proxy.error,
      url: proxyUrl(),
      target: directUrl(),
      routeViaProxy: settings.routeViaProxy === true,
      effectiveRoute: settings.routeViaProxy === true ? proxyUrl() : directUrl(),
      captures: proxy.captures.slice(-CAPTURE_LIMIT),
    }
  }

  function clearCaptures() {
    proxy.captures.length = 0
  }

  // --- hybrid local worker -------------------------------------------------

  const hybrid = { disposers: [], registered: false, error: null }

  /** One chat call straight at llama-server; never through the capture proxy. */
  async function callLocalModel(body, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${directUrl()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`本地模型返回 ${response.status}：${(await response.text()).slice(0, 200)}`)
      }
      const payload = await response.json()
      const message = payload?.choices?.[0]?.message ?? {}
      const content = typeof message.content === 'string' ? message.content.trim() : ''
      if (content === '') {
        const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0
        throw new Error(
          `本地模型只输出了思考（${reasoning} 字符）没有正文：通常是思考没关掉，检查 --reasoning-budget 与请求里的 enable_thinking`,
        )
      }
      return content
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new Error(`本地模型超时（${timeoutMs} ms）`)
      }
      throw cause
    } finally {
      clearTimeout(timer)
    }
  }

  /** The worker runs only when the server answers; optionally start it first. */
  async function ensureLocalReady() {
    if (await health(settings.port, 2000)) return { ok: true }
    if (settings.autoStartLocal !== true) {
      return {
        ok: false,
        error: '本地模型没在运行：到设置 →「本地模型」点启动，或在「混合工作流」里打开「需要时自动拉起」',
      }
    }
    const started = await start()
    if (started.ok === false) return { ok: false, error: started.error }
    const deadline = Date.now() + Math.min(settings.localTimeoutMs, 180000)
    while (Date.now() < deadline) {
      if (await health(settings.port, 2000)) return { ok: true, started: true }
      await sleep(1000)
    }
    return { ok: false, error: '自动拉起本地模型超时' }
  }

  /** (Re)register the tool and its prompt section to match the current settings. */
  function syncHybrid() {
    for (const dispose of hybrid.disposers) {
      try {
        dispose()
      } catch {
        // Already disposed with its owner.
      }
    }
    hybrid.disposers = []
    hybrid.registered = false
    hybrid.error = null
    if (settings.hybridEnabled !== true) return

    const tools = ctx.get('tools')
    if (tools === undefined) {
      hybrid.error = 'tools 服务不可用'
      return
    }
    try {
      hybrid.disposers.push(tools.register(createLocalWorker({
        // The worker always follows the active model: the getter re-reads the
        // settings on every call, so a switch is picked up without re-registering.
        getSettings: () => ({ ...settings, profile: target() }),
        callLocal: callLocalModel,
        ensureReady: ensureLocalReady,
        runFile,
        tempRoot: join(homedir(), '.dsh', 'data', 'dsh-local-llm', 'frames'),
      })))
      const prompt = ctx.get('systemPrompt')
      if (prompt !== undefined) {
        hybrid.disposers.push(prompt.section({
          name: 'local-worker',
          order: 300,
          text: hybridPromptText({ ...settings, profile: target() }),
        }))
      }
      hybrid.registered = true
    } catch (cause) {
      hybrid.error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function disposeHybrid() {
    for (const dispose of hybrid.disposers) {
      try {
        dispose()
      } catch {
        // Already disposed.
      }
    }
    hybrid.disposers = []
    hybrid.registered = false
  }

  // --- status --------------------------------------------------------------

  function currentPid() {
    if (child?.pid !== undefined && isAlive(child.pid)) return child.pid
    const fromFile = Number((readText(pidPath) ?? '').trim())
    if (Number.isInteger(fromFile) && fromFile > 0 && isAlive(fromFile)) return fromFile
    return null
  }

  function isDirty() {
    if (launch?.settings === undefined) return false
    const profile = activeProfile()
    return MODEL_FIELDS.some((key) => profile.fields.includes(key)
      && String(launch.settings[key]) !== String(settings[key]))
  }

  /**
   * Which other models are listening. Probed in the background at most every few
   * seconds: the page polls `status` every 1.5 s and must never wait on two extra
   * timeouts.
   */
  let othersCache = { at: 0, value: [] }

  function refreshOthers() {
    const now = Date.now()
    if (now - othersCache.at < 5000) return
    othersCache.at = now
    const active = settings.activeModel
    Promise.all(MODELS.filter((model) => model.id !== active).map(async (model) => {
      const port = settingsFor(model.id).port
      return (await health(port, 700)) ? { id: model.id, name: model.name, port } : null
    })).then((rows) => {
      othersCache.value = rows.filter((row) => row !== null)
    }).catch(() => {})
  }

  async function status() {
    refreshOthers()
    const ready = await health()
    if (ready && phase !== 'ready') phase = 'ready'
    if (!ready && phase === 'ready') phase = 'stopped'

    const pid = currentPid()
    let resolvedPhase = phase
    if (ready) resolvedPhase = 'ready'
    else if (resolvedPhase === 'starting') resolvedPhase = pid === null ? 'failed' : 'starting'
    else if (resolvedPhase === 'failed') resolvedPhase = 'failed'
    else resolvedPhase = 'stopped'
    if (resolvedPhase === 'failed' && error === null && pid === null) {
      error = '进程已退出，但没有记录到错误信息。'
    }

    const startedAt = launch?.at ?? null
    const elapsed = startedAt === null ? null : Math.round((Date.now() - startedAt) / 1000)

    return {
      phase: resolvedPhase,
      build: BUILD,
      model: target(),
      others: othersCache.value,
      ready,
      running: resolvedPhase === 'ready' || (resolvedPhase === 'starting' && pid !== null),
      pid,
      external: ready && pid !== null && launch?.pid !== pid,
      port: settings.port,
      baseUrl: `http://127.0.0.1:${settings.port}/v1`,
      startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
      elapsedSeconds: elapsed,
      loadSeconds: ready && resolvedPhase === 'ready' && launch !== null ? elapsed : null,
      vram: ready || resolvedPhase === 'starting' ? await vram() : null,
      error: resolvedPhase === 'failed' ? error : null,
      logTail: resolvedPhase === 'failed' ? tailLines(errLog, 20) : [],
      dirty: isDirty(),
      installDir: activeProfile().installDir,
      exeOk: existsSync(exePath),
      args: launch?.args ?? null,
      proxy: proxyStatus(),
      hybrid: {
        enabled: settings.hybridEnabled === true,
        registered: hybrid.registered,
        error: hybrid.error,
      },
    }
  }

  // --- control -------------------------------------------------------------

  async function start() {
    if (await health()) {
      phase = 'ready'
      return { ok: true, already: true, phase }
    }
    if (!existsSync(exePath)) {
      return { ok: false, error: `找不到 llama-server：${exePath}` }
    }
    const modelPath = join(modelsDir, settings.modelFile)
    if (!existsSync(modelPath)) {
      return { ok: false, error: `找不到模型文件：${modelPath}` }
    }
    if (settings.vision && !existsSync(join(modelsDir, settings.mmprojFile))) {
      return { ok: false, error: `找不到视觉投影文件：${join(modelsDir, settings.mmprojFile)}` }
    }
    mkdirSync(logsDir, { recursive: true })

    const help = await helpText()
    const args = buildArgs(settings, help)

    let childProcess
    try {
      const outFd = openSync(outLog, 'a')
      const errFd = openSync(errLog, 'a')
      try {
        childProcess = spawn(exePath, args, {
          cwd: activeProfile().installDir,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
        })
        // A binary that cannot be started reports as an 'error' event, not as a
        // thrown exception. With no listener Node treats that event as fatal and
        // terminates the host process: the user clicks 启动 and DSH disappears,
        // leaving an empty server.err.log and a pid file that says "undefined".
        // Handling it here degrades that into a red status light with a reason.
        childProcess.on('error', (cause) => {
          if (stopIntent) return
          phase = 'failed'
          error = `llama-server 启动失败：${cause instanceof Error ? cause.message : String(cause)}`
        })
      } finally {
        closeSync(outFd)
        closeSync(errFd)
      }
    } catch (cause) {
      phase = 'failed'
      error = cause instanceof Error ? cause.message : String(cause)
      return { ok: false, error }
    }

    childProcess.unref()
    child = childProcess
    stopIntent = false
    phase = 'starting'
    error = null
    launch = { at: Date.now(), pid: childProcess.pid, settings: { ...settings }, args }
    try {
      // A failed spawn leaves `pid` undefined; writing that would replace a useful
      // pid file with the literal text "undefined" and hide the real failure.
      if (typeof childProcess.pid === 'number') {
        writeFileSync(pidPath, String(childProcess.pid), 'ascii')
      }
    } catch {
      // A pid file is a convenience for stop(); in-memory state still works.
    }
    persist()

    childProcess.on('exit', (code, signal) => {
      if (child !== childProcess) return
      if (stopIntent) {
        phase = 'stopped'
      } else {
        phase = 'failed'
        error = `llama-server 退出（code ${code ?? '-'}${signal ? `, signal ${signal}` : ''}）`
      }
    })

    return { ok: true, phase: 'starting', pid: childProcess.pid, args }
  }

  async function stop() {
    stopIntent = true
    const targets = new Set()
    if (child?.pid !== undefined) targets.add(child.pid)
    const fromFile = Number((readText(pidPath) ?? '').trim())
    if (Number.isInteger(fromFile) && fromFile > 0) targets.add(fromFile)

    const failures = []
    for (const pid of targets) {
      const result = await killNode(pid)
      if (!result.ok) failures.push(result.error)
    }
    // Anything still listening on the port (a hand-started server, or a PID the
    // pid file missed) is stopped too — otherwise the page reports "stopped"
    // while the port is still taken.
    if (await health(settings.port, 800)) {
      const owner = await portOwner(settings.port)
      if (owner !== null) {
        const result = await killNode(owner)
        if (!result.ok) failures.push(result.error)
      }
    }

    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (!(await health(settings.port, 800))) break
      await sleep(300)
    }
    const stillUp = await health(settings.port, 800)

    if (!stillUp) {
      // The port closes before the process leaves memory; wait for the real exit
      // so the page's "已停止" is not a lie and VRAM is actually released.
      for (const pid of targets) {
        if (!isAlive(pid)) continue
        const deadline = Date.now() + 10000
        while (Date.now() < deadline && isAlive(pid)) await sleep(200)
        if (isAlive(pid)) failures.push(`PID ${pid} 仍在运行`)
      }
    }

    if (stillUp) {
      phase = 'failed'
      error = failures.length > 0 ? failures.join('；') : '端口仍在监听，停止未完成。'
      return { ok: false, error }
    }

    try {
      unlinkSync(pidPath)
    } catch {
      // Already gone.
    }
    child = null
    launch = null
    phase = 'stopped'
    error = null
    stopIntent = false
    persist()
    return { ok: true, phase, warnings: failures.length > 0 ? failures : undefined }
  }

  async function restart() {
    const stopped = await stop()
    if (!stopped.ok) return stopped
    return await start()
  }

  /** Persist the flat view into the profile it belongs to. */
  function saveCurrentProfile() {
    const profile = activeProfile()
    settings.profiles = {
      ...settings.profiles,
      [profile.id]: { ...settings.profiles[profile.id], ...pickModelFields(profile, settings) },
    }
  }

  /** Make the active profile the flat view the rest of the runtime reads. */
  function applyActiveProfile() {
    const profile = activeProfile()
    const values = { ...defaultSettingsFor(profile), ...(settings.profiles[profile.id] ?? {}) }
    settings.profiles[profile.id] = values
    for (const key of MODEL_FIELDS) delete settings[key]
    Object.assign(settings, values)
  }

  /**
   * Switch the active model. Only one fits in 8 GB, so a running model is stopped
   * first; the target is started only when something was running before, which
   * keeps a plain selection change free of VRAM churn.
   */
  async function switchModel(modelId) {
    const target = modelById(modelId)
    if (target.id !== modelId) return { ok: false, error: `未知模型：${String(modelId)}` }
    const previous = settings.activeModel
    if (target.id === previous) {
      return { ok: true, switched: false, activeModel: previous, phase }
    }

    const targetValues = settingsFor(target.id)
    const targetAlreadyReady = await health(targetValues.port, 1500)
    const wasRunning = targetAlreadyReady ? false : await health(settings.port, 1500)

    let stopResult = null
    if (wasRunning) {
      stopResult = await stop()
      if (stopResult.ok === false) return { ok: false, error: stopResult.error, activeModel: previous }
    }

    saveCurrentProfile()
    settings.activeModel = target.id
    applyActiveProfile()
    refreshPaths()
    launch = null
    phase = 'idle'
    error = null
    persist()

    let started = false
    let startError = null
    if (wasRunning) {
      const result = await start()
      started = result.ok !== false
      if (!started) startError = result.error ?? '启动失败'
    }

    syncHybrid()
    return {
      ok: started || !wasRunning,
      switched: true,
      activeModel: target.id,
      previous,
      started,
      alreadyReady: targetAlreadyReady,
      stop: stopResult,
      error: startError,
    }
  }

  // --- settings ------------------------------------------------------------

  function clampInt(value, [min, max], label) {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`${label} 必须是数字`)
    const rounded = Math.round(number)
    if (rounded < min || rounded > max) throw new Error(`${label} 需在 ${min}-${max} 之间`)
    return rounded
  }

  function clampRatio(value, [min, max], label) {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new Error(`${label} 必须是数字`)
    const rounded = Math.round(number * 100) / 100
    if (rounded < min || rounded > max) throw new Error(`${label} 需在 ${min}-${max} 之间`)
    return rounded
  }

  function sanitize(patch) {
    const next = { ...settings }
    const profile = activeProfile()
    const allows = (key) => profile.fields.includes(key)

    if (allows('port') && patch.port !== undefined) next.port = clampInt(patch.port, LIMITS.port, '端口')
    if (allows('contextSize') && patch.contextSize !== undefined) {
      next.contextSize = clampInt(patch.contextSize, LIMITS.contextSize, '上下文长度')
    }
    if (allows('threads') && patch.threads !== undefined) {
      next.threads = clampInt(patch.threads, LIMITS.threads, '线程数')
    }
    if (allows('vision') && patch.vision !== undefined) next.vision = patch.vision === true
    if (allows('thinking') && patch.thinking !== undefined) next.thinking = patch.thinking === true
    if (allows('modelFile') && patch.modelFile !== undefined) {
      if (!modelFiles().includes(patch.modelFile)) throw new Error('选择的主模型文件不存在')
      next.modelFile = patch.modelFile
    }
    if (allows('mmprojFile') && patch.mmprojFile !== undefined) {
      if (patch.mmprojFile !== '' && !mmprojFiles().includes(patch.mmprojFile)) {
        throw new Error('选择的视觉投影文件不存在')
      }
      next.mmprojFile = patch.mmprojFile
    }
    if (allows('reasoningBudget') && patch.reasoningBudget !== undefined) {
      next.reasoningBudget = clampInt(patch.reasoningBudget, LIMITS.reasoningBudget, '思考预算')
    }
    if (allows('reasoningPreserve') && patch.reasoningPreserve !== undefined) {
      next.reasoningPreserve = patch.reasoningPreserve === true
    }
    if (allows('temperature') && patch.temperature !== undefined) {
      const raw = Number(patch.temperature)
      if (!Number.isFinite(raw) || raw < LIMITS.temperature[0] || raw > LIMITS.temperature[1]) {
        throw new Error(`temperature 需在 ${LIMITS.temperature[0]}-${LIMITS.temperature[1]} 之间`)
      }
      next.temperature = Math.round(raw * 100) / 100
    }
    if (patch.compactionEnabled !== undefined) next.compactionEnabled = patch.compactionEnabled === true
    if (patch.compactionThresholdRatio !== undefined) {
      next.compactionThresholdRatio = clampRatio(
        patch.compactionThresholdRatio,
        LIMITS.compactionThresholdRatio,
        '压缩触发比例',
      )
    }
    if (patch.compactionRetainTokens !== undefined) {
      next.compactionRetainTokens = clampInt(
        patch.compactionRetainTokens,
        LIMITS.compactionRetainTokens,
        '保留原文 token',
      )
    }
    if (patch.summarizationProvider !== undefined || patch.summarizationModel !== undefined) {
      const provider = String(patch.summarizationProvider ?? next.summarizationProvider ?? '').trim()
      const model = String(patch.summarizationModel ?? next.summarizationModel ?? '').trim()
      if ((provider === '') !== (model === '')) throw new Error('摘要模型需要 provider 与 model 同时给出，或同时留空')
      next.summarizationProvider = provider
      next.summarizationModel = model
    }
    if (patch.proxyEnabled !== undefined) next.proxyEnabled = patch.proxyEnabled === true
    if (patch.proxyPort !== undefined) next.proxyPort = clampInt(patch.proxyPort, LIMITS.proxyPort, '代理端口')
    if (patch.routeViaProxy !== undefined) next.routeViaProxy = patch.routeViaProxy === true
    if (patch.hybridEnabled !== undefined) next.hybridEnabled = patch.hybridEnabled === true
    if (patch.hybridOnlineProvider !== undefined) {
      next.hybridOnlineProvider = String(patch.hybridOnlineProvider ?? '').trim()
    }
    if (patch.hybridOnlineModel !== undefined) {
      next.hybridOnlineModel = String(patch.hybridOnlineModel ?? '').trim()
    }
    if (patch.choreText !== undefined) next.choreText = patch.choreText === true
    if (patch.choreImage !== undefined) next.choreImage = patch.choreImage === true
    if (patch.choreVideo !== undefined) next.choreVideo = patch.choreVideo === true
    if (patch.localTimeoutMs !== undefined) {
      next.localTimeoutMs = clampInt(patch.localTimeoutMs, LIMITS.localTimeoutMs, '本地调用超时')
    }
    if (patch.choreMaxInputChars !== undefined) {
      next.choreMaxInputChars = clampInt(patch.choreMaxInputChars, LIMITS.choreMaxInputChars, '文本输入上限')
    }
    if (patch.choreMaxOutputTokens !== undefined) {
      next.choreMaxOutputTokens = clampInt(patch.choreMaxOutputTokens, LIMITS.choreMaxOutputTokens, '输出上限')
    }
    if (patch.videoFrames !== undefined) next.videoFrames = clampInt(patch.videoFrames, LIMITS.videoFrames, '抽帧数')
    if (patch.ffmpegPath !== undefined) next.ffmpegPath = String(patch.ffmpegPath ?? '').trim()
    if (patch.autoStartLocal !== undefined) next.autoStartLocal = patch.autoStartLocal === true
    for (const key of ['installDir', 'exePath', 'modelsDir', 'logsDir']) {
      if (patch[key] !== undefined) next[key] = String(patch[key] ?? '').trim()
    }
    if ((next.hybridOnlineProvider === '') !== (next.hybridOnlineModel === '')) {
      throw new Error('在线模型需要 provider 与 model 同时给出，或同时留空（留空 = 跟随会话）')
    }

    // A proxy that listens on the model's own port would forward to itself.
    if (next.proxyEnabled === true && next.proxyPort === next.port) {
      throw new Error('代理端口不能和 llama-server 端口相同')
    }

    // A budget at or above the output cap leaves no room for the answer, which is
    // the exact failure this setting exists to prevent.
    if (next.thinking && next.reasoningBudget > 0) {
      const cap = maxTokensFor(next.contextSize)
      if (next.reasoningBudget >= cap) {
        throw new Error(`思考预算需小于单次输出上限（当前上限 ${cap} token）`)
      }
    }

    // Mirror the active model's fields back into its saved profile.
    next.profiles = { ...settings.profiles }
    next.profiles[next.activeModel] = {
      ...next.profiles[next.activeModel],
      ...pickModelFields(profile, next),
    }
    return next
  }

  /** Where the plugin looks for the deployment, and whether each piece is there. */
  function pathsReport() {
    const resolved = resolvePaths()
    const has = (path) => existsSync(path)
    const models = modelFiles()
    const mmproj = mmprojFiles()
    return {
      settings: {
        installDir: settings.installDir,
        exePath: settings.exePath,
        modelsDir: settings.modelsDir,
        logsDir: settings.logsDir,
      },
      resolved,
      items: [
        { key: 'installDir', path: resolved.root, exists: has(resolved.root) },
        { key: 'exePath', path: resolved.exe, exists: has(resolved.exe) },
        { key: 'modelsDir', path: resolved.models, exists: has(resolved.models) },
        { key: 'logsDir', path: resolved.logs, exists: has(resolved.logs) },
      ],
      files: models,
      mmproj,
      modelFile: { name: settings.modelFile, exists: has(join(resolved.models, settings.modelFile)) },
      mmprojFile: { name: settings.mmprojFile, exists: settings.mmprojFile === '' || has(join(resolved.models, settings.mmprojFile)) },
      ready: has(resolved.exe)
        && has(resolved.models)
        && models.includes(settings.modelFile)
        && (settings.vision !== true || mmproj.includes(settings.mmprojFile)),
    }
  }

  async function describe() {
    const profile = activeProfile()
    const route = routeInfo(profile.provider)
    const editor = configEditor()
    const provider = providerValues(editor, profile)
    const compaction = compactionState(editor)
    const derivedMax = maxTokensFor(settings.contextSize)

    const expectedBase = `http://127.0.0.1:${settings.port}/v1`
    const drift = []
    if (provider.baseUrl !== null && provider.baseUrl !== expectedBase) drift.push('baseURL 端口与设置不一致')
    if (provider.contextWindow !== null && provider.contextWindow !== settings.contextSize) {
      drift.push(`contextWindow ${provider.contextWindow} ≠ 设置 ${settings.contextSize}`)
    }
    if (provider.maxTokens !== null && provider.maxTokens !== derivedMax) {
      drift.push(`maxTokens ${provider.maxTokens} ≠ 推算 ${derivedMax}`)
    }

    refreshOthers()

    return {
      settings,
      defaults: DEFAULTS,
      limits: LIMITS,
      editable: EDITABLE,
      model: { ...target(), others: othersCache.value },
      models: MODELS.map((entry) => ({ id: entry.id, name: entry.name, provider: entry.provider, model: entry.model })),
      files: modelFiles(),
      mmproj: mmprojFiles(),
      paths: pathsReport(),
      installDir: profile.installDir,
      exePath,
      modelsDir,
      logsDir,
      exeOk: existsSync(exePath),
      statePath,
      launch: launch === null
        ? null
        : { at: new Date(launch.at).toISOString(), pid: launch.pid, settings: launch.settings, args: launch.args ?? [] },
      route: {
        path: route.path,
        baseUrl: route.baseUrl,
        port: route.port,
        matches: route.port === null ? null : route.port === settings.port,
      },
      provider: { ...provider, drift },
      derived: { maxTokens: derivedMax, compaction: compaction.derived },
      compaction: {
        enabled: settings.compactionEnabled !== false,
        available: compaction.available,
        presets: compaction.presets,
        drift: compaction.drift,
        policies: compaction.policies,
      },
      summarization: {
        provider: settings.summarizationProvider,
        model: settings.summarizationModel,
        choices: await summarizationChoices(),
      },
      proxy: {
        enabled: settings.proxyEnabled === true,
        port: settings.proxyPort,
        listening: proxy.listening,
        error: proxy.error,
        url: proxyUrl(),
        target: directUrl(),
        routeViaProxy: settings.routeViaProxy === true,
        effectiveRoute: settings.routeViaProxy === true ? proxyUrl() : directUrl(),
        captureCount: proxy.captures.length,
      },
      hybrid: {
        enabled: settings.hybridEnabled === true,
        registered: hybrid.registered,
        error: hybrid.error,
        onlineProvider: settings.hybridOnlineProvider,
        onlineModel: settings.hybridOnlineModel,
        chores: {
          text: settings.choreText === true,
          image: settings.choreImage === true,
          video: settings.choreVideo === true,
        },
        videoFrames: settings.videoFrames,
        localTimeoutMs: settings.localTimeoutMs,
        choreMaxInputChars: settings.choreMaxInputChars,
        choreMaxOutputTokens: settings.choreMaxOutputTokens,
        autoStartLocal: settings.autoStartLocal === true,
        ffmpeg: resolveFfmpeg(settings.ffmpegPath),
        prompt: hybridPromptText(settings),
      },
    }
  }

  async function save(patch) {
    const before = { ...settings }
    const next = sanitize(patch ?? {})
    settings = next
    refreshPaths()
    persist()

    const contextChanged = next.contextSize !== before.contextSize
    const portChanged = next.port !== before.port
    const pathsChanged = next.installDir !== before.installDir
      || next.exePath !== before.exePath
      || next.modelsDir !== before.modelsDir
      || next.logsDir !== before.logsDir
    const routeChanged = next.routeViaProxy !== before.routeViaProxy
      || (next.routeViaProxy === true && next.proxyPort !== before.proxyPort)
    const proxyChanged = next.proxyEnabled !== before.proxyEnabled || next.proxyPort !== before.proxyPort
    const compactionTouched = contextChanged
      || next.compactionThresholdRatio !== before.compactionThresholdRatio
      || next.compactionRetainTokens !== before.compactionRetainTokens
      || next.compactionEnabled !== before.compactionEnabled
      || next.summarizationProvider !== before.summarizationProvider
      || next.summarizationModel !== before.summarizationModel

    if (proxyChanged) startProxy()

    // The worker tool is registered on demand, so every save must resync it —
    // cheap when the mode is off, and it picks up chore toggles immediately.
    syncHybrid()

    const providerSync = contextChanged || portChanged || routeChanged
      ? await syncProviderConfig()
      : null
    const compactionSync = compactionTouched ? await syncCompactionPolicy() : null

    return {
      ok: true,
      settings,
      dirty: isDirty(),
      providerSync,
      compactionSync,
      hybrid: { registered: hybrid.registered, error: hybrid.error },
      paths: pathsReport(pathsChanged),
      routeUpdated: providerSync?.updated === true,
      routeReason: providerSync?.reason ?? null,
      route: routeInfo(),
    }
  }

  async function sync(scope = 'all') {
    const result = {}
    if (scope === 'all' || scope === 'route') result.provider = await syncProviderConfig()
    if (scope === 'all' || scope === 'compaction') result.compaction = await syncCompactionPolicy()
    if (scope === 'all' || scope === 'hybrid') {
      syncHybrid()
      result.hybrid = { registered: hybrid.registered, error: hybrid.error }
    }
    return result
  }

  return {
    status,
    start,
    stop,
    restart,
    switchModel,
    describe,
    save,
    sync,
    startProxy,
    stopProxy,
    proxyStatus,
    clearCaptures,
    syncHybrid,
    disposeHybrid,
    detect: pathsReport,
  }
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

function sendJson(response, code, value) {
  const body = JSON.stringify(value)
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

async function readBody(request, limit = 64 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

async function readJsonBody(request) {
  const text = await readBody(request)
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null ? value : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function methodOf(request) {
  return String(request.method ?? 'GET').toUpperCase()
}

function mountRoutes(webServer, runtime) {
  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: async (_request, response) => {
      try {
        sendJson(response, 200, await runtime.status())
      } catch (cause) {
        sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/config`,
    handler: async (request, response) => {
      if (methodOf(request) === 'GET') {
        try {
          sendJson(response, 200, await runtime.describe())
        } catch (cause) {
          sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
        }
        return
      }
      if (methodOf(request) !== 'POST') {
        sendJson(response, 405, { error: '只支持 GET / POST' })
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: '只接受同源请求' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const result = await runtime.save(body.patch ?? body)
        sendJson(response, 200, result)
      } catch (cause) {
        sendJson(response, 400, { error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/sync`,
    handler: async (request, response) => {
      if (methodOf(request) !== 'POST') {
        sendJson(response, 405, { error: '只支持 POST' })
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: '只接受同源请求' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const scope = body.scope === 'route' || body.scope === 'compaction' ? body.scope : 'all'
        sendJson(response, 200, { ok: true, ...(await runtime.sync(scope)) })
      } catch (cause) {
        sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/proxy`,
    handler: async (request, response) => {
      if (methodOf(request) === 'GET') {
        sendJson(response, 200, runtime.proxyStatus())
        return
      }
      if (methodOf(request) !== 'POST') {
        sendJson(response, 405, { error: '只支持 GET / POST' })
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: '只接受同源请求' })
        return
      }
      const body = await readJsonBody(request)
      if (body.action === 'clear') {
        runtime.clearCaptures()
        sendJson(response, 200, { ok: true, ...runtime.proxyStatus() })
        return
      }
      sendJson(response, 400, { error: '未知操作' })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/detect`,
    handler: async (request, response) => {
      if (methodOf(request) !== 'POST' && methodOf(request) !== 'GET') {
        sendJson(response, 405, { error: '只支持 GET / POST' })
        return
      }
      try {
        sendJson(response, 200, { ok: true, ...runtime.detect() })
      } catch (cause) {
        sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/switch`,
    handler: async (request, response) => {
      if (methodOf(request) !== 'POST') {
        sendJson(response, 405, { error: '只支持 POST' })
        return
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: '只接受同源请求' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const result = await runtime.switchModel(String(body.model ?? ''))
        sendJson(response, result.ok === false ? 409 : 200, result)
      } catch (cause) {
        sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  }))

  for (const action of ['start', 'stop', 'restart']) {
    disposers.push(webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/${action}`,
      handler: async (request, response) => {
        if (methodOf(request) !== 'POST') {
          sendJson(response, 405, { error: '只支持 POST' })
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: '只接受同源请求' })
          return
        }
        try {
          const result = await runtime[action]()
          sendJson(response, result.ok === false ? 409 : 200, result)
        } catch (cause) {
          sendJson(response, 500, { error: cause instanceof Error ? cause.message : String(cause) })
        }
      },
    }))
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Already removed with the web server.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config)

  // The capture proxy is an ordinary host-side listener on its own loopback port,
  // so its URL stays stable no matter which port the Web GUI binds.
  ctx.effect(() => {
    runtime.startProxy()
    return () => runtime.stopProxy()
  }, 'dsh-local-llm: capture proxy')

  // The worker tool needs both registries: tools owns the schema the model sees,
  // systemPrompt owns the guidance that tells it when the worker is worth calling.
  ctx.inject(['tools', 'systemPrompt'], (workerCtx) => {
    workerCtx.effect(() => {
      runtime.syncHybrid()
      return () => runtime.disposeHybrid()
    }, 'dsh-local-llm: hybrid worker')
  })

  // Routes ride a `webServer` sub-fiber: loader entries settle concurrently, so a
  // one-shot ctx.get() here would silently skip the mount when the web server
  // activates later.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const webServer = webCtx.get('webServer')
      if (webServer === undefined) return () => {}
      return mountRoutes(webServer, runtime)
    }, 'dsh-local-llm: routes')
  })
}
