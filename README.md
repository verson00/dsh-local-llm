# dsh-local-llm

在 **DeepSeek Harness（DSH）的设置页里管理本机 llama.cpp 的 Qwen3.5-4B**：启停、启动参数、部署路径、
模型路由与压缩策略联动，外加一个请求捕获代理和「混合工作流」工具。

> 面向 DSH `0.2.x`（在 `0.2.1-rc.5` 上开发与验证）。插件本身**零依赖、零构建**：host 半是 ESM，
> client 半是手写模块，装进 profile 即可用。

---

## 功能

### 1. 启停与状态
- 一键启动 / 停止 / 重启本机 `llama-server`（插件自己 spawn，参数由页面决定）。
- 状态灯：绿=就绪、黄闪=加载中、灰=已停止、红=失败；失败时直接展开 `server.err.log` 末尾。
- 显示加载耗时、PID、端口、显存占用；启动参数可随时查看。
- **与手动启动共存**：与 `start.ps1` 共用 pid 文件与日志，脚本起的服务显示「已就绪（外部启动）」，也能从页面停掉。

### 2. 启动参数
上下文长度（512–262144，8 GB 卡建议 ≤ 65536）、线程数、端口、主模型 / 视觉投影文件（自动扫描模型目录的 `.gguf`）、
视觉开关、思考模式与预算、历史思考保留、采样温度（按模型能力显示）。

### 3. 部署路径与检测
安装根目录、`llama-server.exe`、模型目录、日志目录四项，**留空按根目录推导**：

```
exe    = <root>\bin\llama-b12069\llama-server.exe
models = <root>\models
logs   = <root>\logs
```

「检测」逐项校验存在性、列出模型目录里的 `.gguf`，给出「部署可用 / 不完整」。
把 Qwen 装到别的盘、别的目录，改路径即可直接接入，不用改代码。

### 4. 模型路由与压缩策略联动
- 自动把 provider `local-qwen` 的 `contextWindow` / `maxTokens` / `baseURL` 与页面设置对齐（写 `cordis.patch.yml`，保留注释）。
- 给 `compaction-basic` 写一条本地模型专用的压缩策略（`headroomTokens: 0` + 显式摘要上限），
  修掉「窗口小 → 触发点为负 → 每步都压缩 → 摘要请求自己溢出」的默认行为。

### 5. 请求捕获（诊断）
插件在自己的 loopback 端口（默认 8091）上起一个透明反向代理，把 provider 路由指过去，
就能看到 DSH **真实发出的请求形状**：消息数/角色分布、思考是以 `reasoning_content` 字段还是内联 `<think>` 回放、
工具输出占多少字符、schema 字节数、`max_tokens`、流式与否。**只记形状不存正文**，不落盘。
页面可一键「让模型走代理 / 改回直连」。

### 6. 混合工作流（`local_worker`）
开启后注册 `local_worker` 工具与一段系统提示，在线模型把自包含的杂活交给本地 4B：

| action | 用途 | 输入 |
| --- | --- | --- |
| `text` | 翻译、摘要、改写、提取要点、格式化 | `path`（插件读文件）或 `input` |
| `image` | 看图、OCR、抄写画面文字 | `paths` |
| `video` | 等距抽帧后逐帧看，返回带时间戳的文字 | `path` + `frames` |

提示词是**默认委托规则**：整文件翻译/摘要传 `path`，不要先把文件读进自己的上下文。
每请求自动带 `chat_template_kwargs: {enable_thinking:false}`（否则输出预算会全花在思考上、正文为空）。

---

## 安装

### 前置
- Windows + NVIDIA GPU（8 GB 显存可跑 4B Q4；更大显存可放宽上下文）。
- [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server.exe`（本项目在 `b12069` 验证）。
- 一份 Qwen3.5-4B 的 GGUF 量化和 mmproj（见下方「模型」）。
- DeepSeek Harness `0.2.x`。

### 步骤

1. **拿到插件目录**（克隆或解压），确认里面是 `package.json` / `index.js` / `lib/` / `client/`。

2. **装进 DSH profile**：在 DSH 里让 agent 执行

   ```
   plugin_manager install_bundle（action: install_bundle, target: <本目录的绝对路径>）
   ```

   它会完成依赖登记、把 bundle 加进 profile 的插件选择，并尝试热加载。
   手动方式等价于在 profile 的 `package.json` 里加一条 `"dsh-local-llm": "link:<本目录>"`，
   并在 bundle 选择列表里加上 `dsh-local-llm`。

3. **重启 DSH**（host 半的代码在启动时加载）。重启后设置页左侧出现「**本地模型**」。

4. **配置路由**（如果还没有）：在 profile 的 `cordis.patch.yml` 里加一条 OpenAI 兼容路由：

   ```yaml
   - id: llm-pi-ai
     name: "@deepseek-ai/dsh-llm-pi-ai"
     config:
       providers:
         local-qwen:
           displayName: 本地 Qwen3.5 4B
           api: openai-completions
           baseURL: http://127.0.0.1:8080/v1
           headers:
             Authorization: Bearer local-no-auth
           models:
             - id: qwen3.5-4b
               name: Qwen3.5 4B (本地)
               contextWindow: 65536
               maxTokens: 8192
               input: [text, image]
               reasoningEfforts: false
   ```

5. **放好模型文件**：把 `Qwen3.5-4B-UD-Q4_K_XL.gguf` 与 `mmproj-F16.gguf` 放进 `<安装根目录>\models\`，
   确认 `llama-server.exe` 在 `<安装根目录>\bin\llama-b12069\`。

---

## 使用

1. 打开 **设置 → 本地模型**。
2. 展开「部署路径」，确认四项都是 ✓（或改成本机实际路径后点「检测」）。
3. 展开「启动参数」，按显存调上下文（8 GB 卡 **≤ 65536**），点「保存」。
4. 回到「服务状态」，点「启动」，等状态灯变绿（约 3–10 秒；加载耗时与显存会显示出来）。
5. 模型选择器里选「**本地 Qwen3.5 4B**」即可对话；或者在会话说里让 agent 用 `local_worker` 干活。
6. 想用混合作业：展开「混合工作流」，打开开关、保存，之后 agent 会把翻译/OCR/抽帧这类活交给本地模型。

停止：设置页点「停止」，或 `stop-llm.cmd`。插件停掉时**不会**杀正在跑的模型（模型是独立进程）。

---

## 模型

- 原始模型页：**[Qwen/Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)**
- 本机使用的文件（GGUF 量化）：
  - `Qwen3.5-4B-UD-Q4_K_XL.gguf`（约 2.8 GB，Unsloth Dynamic 量化命名）
  - `mmproj-F16.gguf`（约 0.7 GB，视觉投影器，看图/OCR 需要）
- 量化文件从 Hugging Face 上的 Qwen3.5-4B **GGUF 仓库**获取（例如 [unsloth/Qwen3.5-4B-GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF)）；以你实际下载源为准。
- 实测（RTX 4060 8 GB，Q4_K_XL + F16 mmproj）：

  | 上下文 | 生成速度 | 专用显存 | 分页到系统内存 |
  | --- | --- | --- | --- |
  | 32768 | 62.9 tok/s | 5509 MB | 154 MB |
  | 162144 | 17.7 tok/s | 8093 MB | 2471 MB |

  超过约 64K 会开始把权重分到系统内存，速度掉到 1/3 左右——长对话请交给压缩策略。

---

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 状态灯红，日志里 `failed to load model` | 模型文件缺失或路径不对；展开「部署路径」点「检测」 |
| 生成很慢（<20 tok/s） | 上下文过大导致显存溢出；把上下文降到 ≤ 65536，或关掉视觉 |
| 启动失败 `port already in use` | 8080 被别的 `llama-server` 占用；先在页面或脚本停掉旧的 |
| 页面上路由显示「不一致」 | 点「同步」把 provider 的 `contextWindow`/`maxTokens` 写回配置 |
| 模型选择器里连不上 | 本地服务没启动（只有本地模型不可用，其他模型不受影响） |
| `local_worker` 返回「本地模型没在运行」 | 先启动服务；或打开混合工作流里的「需要时自动拉起」 |

---

## 开发

- 无构建步骤：host 半 `index.js`（ESM），client 半 `client/client.js`（`window.__ModuleLoader__`），模型档案在 `lib/models.js`。
- 改了 host 半**必须重启 DSH**；改 client 半刷新页面即可。
- 本机 HTTP 路由都在 `/local-llm` 下：`GET status`、`GET|POST config`、`POST start|stop|restart|sync|detect`、`GET|POST proxy`；
  POST 只接受同源请求，请求体上限 64 KiB。

## 许可

[MIT](LICENSE)
