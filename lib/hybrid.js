/**
 * dsh-local-llm — the "local worker" half of the hybrid setup.
 *
 * The online model drives the conversation; this module gives it one cheap tool
 * for work that does not need the big model: OCR / image reading, video frame
 * reading, and bulk text chores (translate, summarise, rewrite, format). Every
 * call is self-contained: one prompt, optional images, one answer.
 *
 * Two facts this module encodes, both measured on this machine:
 * - llama.cpp accepts OpenAI vision bodies (`image_url` + data URL) with the
 *   mmproj loaded, and charges ~1024 prompt tokens per image.
 * - Thinking must be disabled per request (`chat_template_kwargs.enable_thinking
 *   = false`): with the server-side thinking budget on, a 400-token chat filled
 *   every token with reasoning and returned empty content.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** Candidate ffmpeg locations when the setting is empty. */
export const FFMPEG_CANDIDATES = [
  'D:\\local-llm\\bin\\ffmpeg\\bin\\ffmpeg.exe',
  'D:\\ocam\\XJScreenRecorder\\ffmpeg.exe',
]

export const LIMITS = {
  maxImageBytes: 8 * 1024 * 1024,
  maxVideoBytes: 512 * 1024 * 1024,
  maxResultChars: 8000,
  maxFrames: 6,
}

export function imageMime(path) {
  return IMAGE_MIME.get(extname(String(path)).toLowerCase()) ?? null
}

/**
 * Resolve the ffmpeg binary: the configured path, then the known local copy,
 * then bare `ffmpeg` on PATH (existence unknown until it runs).
 */
export function resolveFfmpeg(configured) {
  const wanted = typeof configured === 'string' ? configured.trim() : ''
  if (wanted !== '') {
    return existsSync(wanted)
      ? { path: wanted, source: 'configured', ok: true }
      : { path: wanted, source: 'configured', ok: false, reason: `配置的 ffmpeg 不存在：${wanted}` }
  }
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) return { path: candidate, source: 'auto', ok: true }
  }
  return { path: 'ffmpeg', source: 'path', ok: true, note: '使用 PATH 里的 ffmpeg' }
}

/**
 * One chat body for a local server.
 *
 * `thinking` is true only for models whose template understands the switch
 * (Qwen): another template can reject the unknown key. `model` is the alias the
 * server was started with.
 */
export function buildChatBody({ task, input, images = [], maxTokens, model = 'qwen3.5-4b', thinking = true }) {
  const text = input === undefined || input === '' ? String(task) : `${task}\n\n${input}`
  const content = images.length === 0
    ? text
    : [
      { type: 'text', text },
      ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ]
  const body = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  }
  if (thinking === true) {
    // Load-bearing for Qwen: without it the budget goes to reasoning and content
    // comes back empty.
    body.chat_template_kwargs = { enable_thinking: false }
  }
  return body
}

/** `Duration: 00:01:12.34` from `ffmpeg -i` output. */
export function parseDurationSeconds(text) {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text))
  if (match === null) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** Evenly spaced sample points, avoiding both ends. */
export function frameTimes(durationSeconds, count) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return []
  const frames = Math.max(1, Math.min(LIMITS.maxFrames, Math.round(Number(count) || 3)))
  return Array.from({ length: frames }, (_, index) => {
    const at = durationSeconds * ((index + 0.5) / frames)
    return Math.round(at * 100) / 100
  })
}

export function formatClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function dataUrl(path, mime) {
  const info = statSync(path)
  if (info.size > LIMITS.maxImageBytes) {
    throw new Error(`图片超过 ${Math.round(LIMITS.maxImageBytes / 1024 / 1024)} MB：${path}`)
  }
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

function truncate(text, limit = LIMITS.maxResultChars) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，原长 ${text.length} 字符）`
}

/**
 * Build the tool definition.
 *
 * @param options.getSettings - current plugin settings
 * @param options.callLocal - (body, timeoutMs) => Promise<string> answer text
 * @param options.ensureReady - () => Promise<{ ok: boolean, error?: string }>
 * @param options.runFile - (file, args, timeoutMs) => Promise<{ ok, stdout, stderr }>
 * @param options.tempRoot - directory for extracted frames
 */
export function createLocalWorker(options) {
  const { getSettings, callLocal, ensureReady, runFile } = options
  const tempRoot = options.tempRoot ?? tmpdir()

  async function readImages(paths) {
    const urls = []
    for (const path of paths) {
      const mime = imageMime(path)
      if (mime === null) throw new Error(`不支持的图片格式（png/jpg/webp/gif）：${path}`)
      if (!existsSync(path)) throw new Error(`图片不存在：${path}`)
      urls.push(dataUrl(path, mime))
    }
    return urls
  }

  async function askLocal({ task, input, images, settings }) {
    const ready = await ensureReady()
    if (ready.ok !== true) throw new Error(ready.error ?? '本地模型不可用')
    const model = settings.profile ?? { alias: 'qwen3.5-4b', flags: { thinking: true } }
    const body = buildChatBody({
      task,
      input,
      images,
      maxTokens: settings.choreMaxOutputTokens,
      model: model.alias,
      // Only templates that understand the switch get it; the others can reject
      // an unknown template kwarg.
      thinking: model.flags?.thinking === true,
    })
    return await callLocal(body, settings.localTimeoutMs)
  }

  /** Read a UTF-8 text file for a text chore, bounded before it reaches the model. */
  function readTextFile(path, settings) {
    if (!existsSync(path)) throw new Error(`文件不存在：${path}`)
    const info = statSync(path)
    if (!info.isFile()) throw new Error(`不是文件：${path}`)
    // 1 MB of bytes is far past the char cap anyway; refuse before reading.
    if (info.size > 1024 * 1024) {
      throw new Error(`文件 ${Math.round(info.size / 1024)} KB 超过 1 MB 读取上限，请先用 pwsh 分段，或直接给 input`)
    }
    let text = readFileSync(path, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (text.length > settings.choreMaxInputChars) {
      throw new Error(
        `文件 ${text.length} 字符超过 ${settings.choreMaxInputChars} 上限，请分段调用，或先把文件切小`,
      )
    }
    return text
  }

  async function runText(args, settings) {
    // `path` lets the caller hand over a file without reading it into its own
    // context first — the difference between delegating and not delegating.
    let body
    if (typeof args.path === 'string' && args.path !== '') {
      body = readTextFile(args.path, settings)
    } else if (typeof args.input === 'string' && args.input.trim() !== '') {
      body = args.input
      if (body.length > settings.choreMaxInputChars) {
        throw new Error(
          `input 超过 ${settings.choreMaxInputChars} 字符上限（当前 ${body.length}），请分段调用`,
        )
      }
    } else {
      throw new Error('action=text 需要 input 或 path（path=文件绝对路径，插件自己读）')
    }
    return await askLocal({ task: args.task, input: body, images: [], settings })
  }

  async function runImages(args, settings) {
    const paths = Array.isArray(args.paths) ? args.paths.filter((path) => typeof path === 'string' && path !== '') : []
    if (paths.length === 0) throw new Error('action=image 需要 paths（图片绝对路径数组）')
    const urls = await readImages(paths)
    const parts = []
    for (let index = 0; index < urls.length; index += 1) {
      const answer = await askLocal({ task: args.task, images: [urls[index]], settings })
      parts.push(paths.length === 1 ? answer : `【${paths[index]}】\n${answer}`)
    }
    return parts.join('\n\n')
  }

  async function videoDuration(ffmpeg, path, timeoutMs) {
    const probe = join(ffmpeg.slice(0, ffmpeg.lastIndexOf('\\') + 1), 'ffprobe.exe')
    if (ffmpeg.includes('\\') && existsSync(probe)) {
      const result = await runFile(probe, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path,
      ], timeoutMs)
      const value = Number(result.stdout.trim())
      if (Number.isFinite(value) && value > 0) return value
    }
    const result = await runFile(ffmpeg, ['-i', path], timeoutMs)
    return parseDurationSeconds(`${result.stderr}\n${result.stdout}`)
  }

  async function runVideo(args, settings) {
    if (typeof args.path !== 'string' || args.path === '') throw new Error('action=video 需要 path')
    if (!existsSync(args.path)) throw new Error(`视频不存在：${args.path}`)
    const size = statSync(args.path).size
    if (size > LIMITS.maxVideoBytes) {
      throw new Error(`视频超过 ${Math.round(LIMITS.maxVideoBytes / 1024 / 1024)} MB`)
    }

    const ffmpeg = resolveFfmpeg(settings.ffmpegPath)
    if (ffmpeg.ok !== true) throw new Error(ffmpeg.reason ?? 'ffmpeg 不可用')
    const ready = await ensureReady()
    if (ready.ok !== true) throw new Error(ready.error ?? '本地模型不可用')

    const timeoutMs = Math.max(settings.localTimeoutMs, 30_000)
    const duration = await videoDuration(ffmpeg.path, args.path, timeoutMs)
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('读不出视频时长（ffmpeg/ffprobe 都失败），无法等距抽帧')
    }
    const frames = Math.max(1, Math.min(LIMITS.maxFrames, Math.round(Number(args.frames) || settings.videoFrames)))
    const times = frameTimes(duration, frames)

    mkdirSync(tempRoot, { recursive: true })
    const workDir = mkdtempSync(join(tempRoot, 'dsh-local-llm-'))
    const parts = []
    try {
      for (let index = 0; index < times.length; index += 1) {
        const file = join(workDir, `frame-${index}.png`)
        const extracted = await runFile(ffmpeg.path, [
          '-v', 'error', '-ss', String(times[index]), '-i', args.path,
          '-frames:v', '1', '-y', file,
        ], timeoutMs)
        if (!existsSync(file)) {
          parts.push(`[${formatClock(times[index])}] 抽帧失败：${extracted.stderr.trim().slice(0, 200)}`)
          continue
        }
        const answer = await askLocal({
          task: args.task,
          images: [dataUrl(file, 'image/png')],
          settings,
        })
        parts.push(`[${formatClock(times[index])}] ${answer}`)
      }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // A leftover temp directory is harmless.
      }
    }
    return parts.join('\n\n')
  }

  return {
    name: 'local_worker',
    description: [
      'Delegate ONE self-contained chore to the small local model (Qwen3.5-4B on this machine: free, private, slow, 32K window, can read images).',
      'DEFAULT for these, not a last resort: translating, summarising, rewriting, extracting points, or bulk formatting a long text or a whole file; reading/OCR of images; describing video frames.',
      'When the whole task is a file, pass `path` and DO NOT read the file into your own context first — the worker reads it. Example: {action:"text", task:"把全文翻成中文，保留原格式", path:"F:\\\\x\\\\LICENSE.txt"}.',
      'Do NOT use it for: anything that needs this conversation, reasoning, planning, or code — those are yours.',
      'Its answer is a draft: verify numbers and names yourself before relying on them.',
      'action=text takes `path` or `input`; action=image takes absolute `paths`; action=video takes an absolute `path` plus `frames`.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['text', 'image', 'video'],
          description: 'Which chore to delegate.',
        },
        task: {
          type: 'string',
          description: 'What the local model must do, e.g. "把全文翻成中文，保留原格式" / "抄出图里所有文字，保留原始换行".',
        },
        input: {
          type: 'string',
          description: 'action=text: the text to process, when it is already short enough to paste.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=image: absolute image paths (png/jpg/webp/gif), one answer per image.',
        },
        path: {
          type: 'string',
          description: 'action=text: absolute path of a UTF-8 file to process (worker reads it; preferred over `input` for files). action=video: absolute video path.',
        },
        frames: {
          type: 'number',
          minimum: 1,
          maximum: LIMITS.maxFrames,
          description: 'action=video: how many frames to sample (default from settings, max 6).',
        },
      },
      required: ['action', 'task'],
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: truncate(String(value ?? '')) }]
      },
    },
    async execute(args) {
      const settings = getSettings()
      if (args.action === 'text') {
        if (settings.choreText !== true) throw new Error('本地文本杂活已关闭（设置 → 混合工作流）')
        return truncate(await runText(args, settings))
      }
      if (args.action === 'image') {
        if (settings.choreImage !== true) throw new Error('本地图片杂活已关闭（设置 → 混合工作流）')
        return truncate(await runImages(args, settings))
      }
      if (args.action === 'video') {
        if (settings.choreVideo !== true) throw new Error('本地视频杂活已关闭（设置 → 混合工作流）')
        return truncate(await runVideo(args, settings))
      }
      throw new Error(`未知 action：${String(args.action)}`)
    },
  }
}

/** The prompt section that tells the driver model what the worker is for. */
export function hybridPromptText(settings) {
  const online = settings.hybridOnlineProvider !== '' && settings.hybridOnlineModel !== ''
    ? `${settings.hybridOnlineProvider}/${settings.hybridOnlineModel}`
    : '当前会话的模型'
  const local = settings.profile ?? { name: 'Qwen3.5-4B', strength: '32K 窗口、可看图' }
  const chores = []
  if (settings.choreImage === true) chores.push('看图/OCR')
  if (settings.choreVideo === true) chores.push('视频抽帧描述')
  if (settings.choreText === true) chores.push('长文翻译/摘要/改写/提取要点')
  return [
    `You drive this session (${online}). A small local model also runs on this machine: ${local.name} (${local.strength}); free, private, and it can read images.`,
    `You MUST hand the following to \`local_worker\` instead of doing them yourself, unless the input genuinely needs this conversation: ${chores.join('、') || '（当前没有开启任何杂活，此规则不适用）'}.`,
    'Translation and summarisation of a whole file are chores: call local_worker with that absolute `path` (the worker reads the file) — do NOT read the file into your own context first, and do not translate it line by line yourself.',
    'Example: {"action":"text","task":"把全文翻译成中文，保留原有结构与编号","path":"F:\\\\work\\\\LICENSE.txt"}.',
    'If the worker is unavailable (tool missing, local model stopped) say so in one line and then do the task yourself; never invent a reason.',
    'Keep reasoning, planning, code, and anything that depends on this conversation to yourself; treat the worker\'s answer as a draft and verify important numbers or names.',
    'For multi-step work use subagent_local instead — local_worker is a single call, not an agent.',
  ].join(' ')
}
