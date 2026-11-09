/**
 * 本地唤醒源（Host-only）
 *
 * 目的：让**外部脚本**能唤醒一个已经在运行的会话，而不需要 DEEPSEEK_API_KEY，
 * 也不需要起 `dsh headless` 新进程。
 *
 * 原理：DSH 里「被唤醒」= 有代码往某个会话投一条 user 消息。
 * QQ 插件就是这么做的（`agent.followup(createUserMessage(...))`）。
 * 这个插件把同一个动作暴露成本机 HTTP 接口：脚本 curl 一下，会话就开始新回合。
 *
 * 只监听 127.0.0.1，并要求 token。
 */
import http from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'wake-source'

/** agents 服务是硬依赖：没有它就没法投消息。 */
export const inject = ['agents']

/** 没活着的会话时，允许新建一个（需要 preset 注册表来挂载 composition）。 */
const optional = ['agentPresets']

const MAX_BODY = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

export function apply(ctx, config = {}) {
  const host = config.host ?? '127.0.0.1'
  const port = Number(config.port ?? 8737)
  const token = String(config.token ?? '')
  const logger = ctx.logger?.('wake-source') ?? console

  /** 把一条文本作为 user 消息投给指定会话；找不到活着的 agent 就返回可诊断的错误。 */
  async function createAndWake(text, opts = {}) {
    const presets = ctx.get('agentPresets')
    let presetId = opts.preset ?? config.agentPreset
    if (!presetId && presets) {
      try {
        presetId = (await presets.resolve()).id
      } catch {
        presetId = undefined
      }
    }
    const sessionId = `session-${crypto.randomUUID()}`
    // 新建的会话没有模型选择可继承，必须显式给 provider/model，否则回合直接报错
    const agentOptions = {}
    const provider = opts.provider ?? config.provider
    const model = opts.model ?? config.model
    const effort = opts.reasoningEffort ?? config.reasoningEffort
    if (provider) agentOptions.provider = provider
    if (model) agentOptions.model = model
    if (effort) agentOptions.reasoningEffort = effort
    const handle = await ctx.agents.create({
      sessionId,
      meta: {
        // 身份根：请求里带 cwd 就用它；否则 config.identityRoot / config.cwd；都没有就跟随启动目录
        cwd: opts.cwd ?? config.identityRoot ?? config.cwd ?? process.cwd(),
        ...(presetId ? { agentPreset: presetId } : {}),
      },
      agentOptions,
      setup: async (agentCtx) => {
        if (presets && presetId) await presets.mount(agentCtx, presetId)
      },
    })
    const message = createUserMessage({
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    })
    handle.agent.followup(message)
    logger.info?.(`wake: created ${sessionId} (preset=${presetId ?? 'default'})`)
    // 跑完就把这个临时会话收掉，避免长期占着内存；失败也不影响回复
    handle.agent
      .whenIdle()
      .then(() => handle.dispose())
      .catch(() => {})
    return { ok: true, session: sessionId, created: true, preset: presetId ?? null }
  }

  function wake(sessionId, text, opts = {}) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      return {
        ok: false,
        code: 'session-not-live',
        message: '该会话没有活着的 agent（网页没打开它，或已经结束）。v1 只支持唤醒活着的会话。',
        live: ctx.agents.list().map((a) => a.id),
      }
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    logger.info?.(`wake: session=${sessionId} chars=${String(text).length}`)
    return { ok: true, session: sessionId, waiting: Boolean(opts.wait) }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`)

      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
          ok: true,
          live: ctx.agents.list().map((a) => a.id),
          identityRoot: config.identityRoot ?? config.cwd ?? process.cwd(),
        })
      }

      if (url.pathname !== '/wake' || req.method !== 'POST') {
        return json(res, 404, { ok: false, code: 'not-found' })
      }

      const got = req.headers['x-wake-token'] ?? url.searchParams.get('token') ?? ''
      if (token && got !== token) {
        return json(res, 401, { ok: false, code: 'bad-token' })
      }

      const body = JSON.parse((await readBody(req)) || '{}')
      const session = body.session ?? body.sessionId
      const text = body.text
      if (!session || typeof text !== 'string' || !text.trim()) {
        return json(res, 400, {
          ok: false,
          code: 'bad-request',
          message: '需要 { session, text }',
        })
      }

      let result = wake(session, text, { wait: body.wait })
      // 没有活着的会话：按需新建一个（body.create !== false）
      if (!result.ok && result.code === 'session-not-live' && body.create !== false) {
        try {
          result = await createAndWake(text, {
            preset: body.preset,
            cwd: body.cwd,
            provider: body.provider,
            model: body.model,
            reasoningEffort: body.reasoningEffort,
          })
        } catch (err) {
          result = { ok: false, code: 'create-failed', message: String(err?.message ?? err) }
        }
      }
      return json(res, result.ok ? 200 : 409, result)
    } catch (err) {
      return json(res, 500, { ok: false, code: 'error', message: String(err?.message ?? err) })
    }
  })

  server.listen(port, host, () => {
    logger.info?.(`wake-source listening on http://${host}:${port}`)
  })

  ctx.effect(() => () => {
    server.close()
  })
}
