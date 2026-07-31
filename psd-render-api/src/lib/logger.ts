/**
 * 结构化日志（pino，Fastify 内置）
 *
 * P2-E 修复：增加 redact 配置，防止敏感数据进入日志：
 *   - disableRequestLogging: false 会记录 req.url，URL query string 中可能携带 token
 *     （历史 /storage/upload?key=...&token=... 已改为 Authorization 头，但其他场景仍可能
 *     出现 token/password 在 query 中）
 *   - 错误对象会携带 err.config.headers.Authorization（axios/fetch 错误冒泡）
 *   - 业务日志可能误传 password/secret/registerSecret 等字段
 *
 *   redact paths 使用点路径匹配，未命中字段会被忽略，配置宽松不会引发错误。
 *   '[*]' 通配符匹配数组中所有元素，'**' 递归匹配嵌套对象所有层级。
 */
import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { env, isProd } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'psd-render-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // P2-E：脱敏路径清单（基于 fast-redact，支持 * 单层通配，不支持 ** 递归）
    //   - HTTP 请求头中的鉴权与 Cookie
    //   - HTTP 响应头中的 Set-Cookie
    //   - URL query 中的 token/password/key（Fastify req.query 对象）
    //   - 业务字段：password/secret/registerSecret/apiKey/accessToken/refreshToken
    //   - axios/fetch 错误冒泡时 err.config.headers.Authorization、err.request._headers.authorization
    //   - 单层通配 *.field 覆盖业务日志中常见的嵌套场景（如 user.password、cfg.registerSecret）
    paths: [
      // HTTP 请求/响应头
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["authorization"]',
      'req.headers["cookie"]',
      'res.headers["set-cookie"]',
      'res.headers["authorization"]',
      // URL query 中的敏感参数
      'req.query.token',
      'req.query.password',
      'req.query.key',
      'req.query.access_token',
      'req.query.refresh_token',
      'req.query.secret',
      // 错误对象中的鉴权头（axios: err.config.headers.Authorization；fetch: err.config.headers.authorization）
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.config.headers.cookie',
      'err.request._headers.authorization',
      'err.request._headers.cookie',
      'err.response.headers["set-cookie"]',
      'err.response.headers.authorization',
      // 业务字段：直接命名（顶层）
      'password',
      'passwordHash',
      'secret',
      'registerSecret',
      'apiKey',
      'api_key',
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'sessionToken',
      'session_token',
      'token',
      'leaseToken',
      'lease_token',
      'downloadToken',
      'uploadToken',
      // 单层通配：覆盖常见嵌套（user.password、cfg.registerSecret、manifest.token 等）
      '*.password',
      '*.passwordHash',
      '*.secret',
      '*.registerSecret',
      '*.apiKey',
      '*.accessToken',
      '*.refreshToken',
      '*.token',
      '*.leaseToken',
      '*.downloadToken',
      '*.uploadToken',
    ],
    // 命中脱敏路径时替换为该字符串（保留字段存在性，便于排查"该字段被脱敏"）
    censor: '[REDACTED]',
    // remove 与 censor 二选一；保留字段路径便于审计
    remove: false,
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname,service',
          },
        },
      }),
});

/**
 * 生成 trace_id（短 UUID）
 *
 * P0 安全修复（低危14）：原 Math.random() 不具备密码学随机性，若未来被复用为
 *   业务幂等键或会话标识可被预测。改用 crypto.randomUUID() 取前 8 字符。
 *   randomUUID 是 v4 UUID，前 8 字符提供 32 bit 熵，足以做日志关联。
 */
export function genTraceId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

export type Logger = typeof logger;
