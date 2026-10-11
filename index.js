/**
 * our-free-model 的 RATE_LIMIT 重试补丁（dsh 侧，不改被补丁的插件）
 *
 * ## 为什么需要它
 *
 * dsh 在注册 provider 路线时这样取重试策略（`dsh-llm/lib/index.js:1867`）：
 *
 *     const retryPolicy = adapter.providerRetryPolicy(provider)
 *       ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`)
 *
 * `??` 只在适配器返回 `undefined` 时才回落到用户配置。而 dsh 自己的默认码表
 * **本来就包含 RATE_LIMIT**（同文件 251-257 行的 `DEFAULT_RETRYABLE_CODES`）：
 *
 *     ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
 *
 * 也就是说 dsh 的基线行为是「遇到 RATE_LIMIT 就重试」。但 dsh-our-free-model
 * 的适配器硬编码返回自己的策略，其中**刻意删掉了 RATE_LIMIT**（其源码注释
 * 写明：这条车道的 429 带递增的 retry-after，重试会把一堵配额墙变成三堵，
 * 见上游 issue #13）。于是：
 *
 *   1. `??` 短路，用户在 settings.yaml 里为该 provider 配的 retryPolicy
 *      **被静默吞掉**，配了也没用，且没有任何提示；
 *   2. 该 provider 成为全机唯一「429 即停止」的路线，与 dsh 自身的默认
 *      行为、与其余所有 provider 的配置都不一致。
 *
 * 同一份代码在 dsh 官方适配器 dsh-llm-pi-ai 上表现相反：它把用户配置透传
 *   （`providerRetryPolicy(p) { return this.current().profiles.get(p)?.retryPolicy }`，
 *   没配就返回 undefined 让 dsh 回落默认值）——所以那条路线上配置是生效的。
 *
 * ## 本补丁做什么
 *
 * 直接改写注册项里的 `retryPolicy` 字段。两点关键（都是实测踩出来的，注释留证）：
 *
 * 1. **不能靠代理适配器的 `providerRetryPolicy()`**。策略在 `prepareRoutes()`
 *    注册那一刻就被**快照**进 `registration.retryPolicy`（dsh-llm/lib/index.js:1867），
 *    之后每次调用读的是这份快照（同文件 2217 行 `retryPolicy: registration.retryPolicy`），
 *    **不再回调适配器**。所以代理改写该方法对已注册的路线毫无作用（实测：策略不变）。
 * 2. **注册时机不确定**。被补丁的插件可能在本插件之前或之后加载，所以两个方向
 *    都要处理：先扫一遍已有注册项，再监听 `llm/adapters-updated` 补上后来注册的。
 *
 * 被补丁的插件目录一个字节都不改，其应用内升级通道（Ed25519 签名清单）保持可用。
 * 策略值来自本插件自己的 config（写在 profile 的 cordis patch 层），缺省时用
 * dsh 的默认码表 + 与用户其余 provider 对齐的退避档位。
 *
 * @module ofm-rate-limit-retry
 */

const ROUTES = ['our-free-model', 'our-free-model-region']

/** 与 dsh 自身默认码表一致（dsh-llm/lib/index.js:251-257）。 */
const DEFAULT_RETRYABLE_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']

/** 与 settings.yaml 中其余 provider 的退避档位对齐（退避 1s→60s）；重试次数取 30 的 100 倍。 */
const DEFAULT_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 3000,
  retryableCodes: Object.freeze(DEFAULT_RETRYABLE_CODES),
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  jitterRatio: 0.2,
})

export const name = 'ofm-rate-limit-retry'
export const inject = ['llm']

export function apply(ctx, config = {}) {
  const resolvePolicy = () => {
    const maxRetries = Number.isSafeInteger(config.maxRetries) && config.maxRetries >= 0
      ? config.maxRetries : DEFAULT_POLICY.maxRetries
    const codes = Array.isArray(config.retryableCodes) && config.retryableCodes.length > 0
      && config.retryableCodes.every(code => typeof code === 'string' && code !== '')
      ? [...new Set(config.retryableCodes)]
      : [...DEFAULT_POLICY.retryableCodes]
    const initialDelayMs = Number.isFinite(config.initialDelayMs) && config.initialDelayMs > 0
      ? config.initialDelayMs : DEFAULT_POLICY.initialDelayMs
    const maxDelayMs = Number.isFinite(config.maxDelayMs) && config.maxDelayMs >= initialDelayMs
      ? config.maxDelayMs : DEFAULT_POLICY.maxDelayMs
    const jitterRatio = Number.isFinite(config.jitterRatio) && config.jitterRatio >= 0 && config.jitterRatio <= 1
      ? config.jitterRatio : DEFAULT_POLICY.jitterRatio
    // 顶层扁平字段：dsh 逐字取用本对象，嵌套在 backoff 里会让退避延迟变 NaN。
    return Object.freeze({
      mode: 'normal',
      maxRetries,
      retryableCodes: Object.freeze(codes),
      initialDelayMs,
      maxDelayMs,
      jitterRatio,
    })
  }

  // ctx.llm 是注入的 mixin 视图、ctx.get('llm') 是服务实例，二者 adapters 是同一个 Map。
  const registry = ctx.llm?.adapters ?? ctx.get?.('llm')?.adapters
  if (!(registry instanceof Map)) {
    ctx.logger.warn('ofm-rate-limit-retry: 未能取得 llm.adapters 注册表，本补丁不生效（dsh 内核结构变化？）')
    return
  }

  const patched = new Set()
  const wrap = () => {
    const policy = resolvePolicy()
    for (const provider of ROUTES) {
      const registration = registry.get(provider)
      if (registration === undefined) continue
      if (patched.has(registration)) continue
      patched.add(registration)
      // 注册项的 retryPolicy 是注册那一刻的快照，调用时直接读它（dsh-llm/lib/index.js:2217），
      // 所以要生效只能改这个字段本身。
      registration.retryPolicy = policy
      ctx.logger.info(`ofm-rate-limit-retry: "${provider}" 的重试策略已改为包含 RATE_LIMIT（maxRetries=${policy.maxRetries}）`)
    }
  }

  wrap()
  ctx.on('llm/adapters-updated', wrap, { priority: 1000 })
}