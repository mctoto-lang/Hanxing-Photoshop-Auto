/**
 * CORS 插件（@fastify/cors）
 * 规范第十一节：同域名不同端口在浏览器安全策略下属于不同源，必须配置 CORS。
 *
 * P2-2 修复：原 credentials=false 与 Admin Cookie 鉴权冲突，
 *   Admin UI 跨子域请求无法携带 Cookie。改为根据 Origin 动态决定：
 *   - Origin 在白名单内：credentials=true，允许携带 Cookie（Admin UI）
 *   - Origin 不在白名单：拒绝（仅 API Key 调用方无 Origin 或自定义 Origin）
 * P2-7 修复：allowedHeaders 增加 X-Trace-Id；methods 增加 PATCH
 */
import fp from 'fastify-plugin';
import cors, { FastifyCorsOptions } from '@fastify/cors';
import { corsOrigins, isProd } from '../config/env.js';

export default fp(async (app) => {
  // P0 安全修复（低危13）：dev 模式也至少限制为 localhost，避免 dev 实例暴露到公网时
  //   任意网站可携带 Cookie 调用 Admin API。允许的 origin 前缀列表：
  //     http://localhost:*  http://127.0.0.1:*  http://[::1]:*
  const localhostPrefixes = [
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
  ];
  const isLocalhostOrigin = (o: string) =>
    localhostPrefixes.some((p) => o === p || o.startsWith(p + ':'));

  const opts: FastifyCorsOptions = {
    // P2-2：动态 origin——白名单内 origin 返回 true 并允许 credentials
    // 不在白名单的 origin 返回 false（拒绝跨域），API Key 调用方无 Origin 时仍可通过
    origin: (origin, cb) => {
      // 无 Origin（如 curl、服务端调用）放行
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      // 开发环境：仅允许 localhost（原实现允许任意源 + credentials，dev 实例暴露公网即可被利用）
      if (!isProd && isLocalhostOrigin(origin)) return cb(null, true);
      // S-H5：静默拒绝——不抛错、不写错误日志、不返回 CORS 头。
      //   浏览器侧表现为预检/实际请求被 CORS 策略拦截（控制台报错但不暴露服务端细节）；
      //   服务端不产生 error 级日志噪声，避免攻击者通过错误响应特征探测可用 origin。
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Trace-Id'],
    // P2-2：允许 credentials 以支持 Admin Cookie 跨子域
    credentials: true,
    maxAge: 86400, // preflight 缓存 24 小时
  };
  await app.register(cors, opts);
});
