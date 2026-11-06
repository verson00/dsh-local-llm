/**
 * dsh-local-llm — the local llama.cpp model this plugin hosts.
 *
 * One profile: where it lives, which provider route it serves, which
 * llama-server flags it needs, and which settings the page shows. The paths are
 * defaults only — the Settings page can point them anywhere (install root,
 * binary, models directory, logs directory), so a fresh Qwen deployment can be
 * plugged in without touching code.
 */

export const MODELS = [
  {
    id: 'qwen',
    name: 'Qwen3.5-4B',
    provider: 'local-qwen',
    model: 'qwen3.5-4b',
    alias: 'qwen3.5-4b',
    installDir: 'D:\\local-llm',
    exeRel: 'bin\\llama-b12069\\llama-server.exe',
    files: { model: 'Qwen3.5-4B-UD-Q4_K_XL.gguf', mmproj: 'mmproj-F16.gguf' },
    defaults: {
      port: 8080,
      contextSize: 65536,
      threads: 6,
      vision: true,
      thinking: false,
      reasoningBudget: 2048,
      reasoningPreserve: false,
    },
    flags: {
      metrics: true,
      thinking: true,
      imageMinTokens: true,
      webui: true,
      temperature: false,
      videoFfmpeg: false,
    },
    fields: [
      'port',
      'contextSize',
      'threads',
      'vision',
      'thinking',
      'reasoningBudget',
      'reasoningPreserve',
      'modelFile',
      'mmprojFile',
    ],
    strength: '32K 窗口、约 60 tok/s、OCR 与长文稳定',
  },
]

export function modelById(id) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0]
}

/** Fresh per-model settings object (files + defaults). */
export function defaultSettingsFor(profile) {
  return {
    ...profile.defaults,
    modelFile: profile.files.model,
    mmprojFile: profile.files.mmproj,
  }
}

/** Copy just the per-model fields out of a settings object. */
export function pickModelFields(profile, source) {
  const picked = {}
  for (const key of profile.fields) {
    picked[key] = source[key]
  }
  return picked
}
