/**
 * 全局错误处理：将 AppError 转为规范错误码响应，其他错误统一 500。
 *
 * P2-4 修复：
 *   1. debug 模式泄露 err.message 改为按 NODE_ENV 判断（生产禁用）
 *   2. 404 不再泄露 url（可能含 token query 参数）
 */
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { ERROR_HTTP_STATUS } from '../types/index.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export default fp(async (app) => {
  app.setErrorHandler((err, req, reply) => {
    // Zod 校验错误 -> 400
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    // B-J1 修复：JSON 解析错误（SyntaxError）-> 400
    //   Fastify v4 默认 JSON parser 在 JSON.parse 失败时抛 SyntaxError，
    //   原实现未捕获 SyntaxError，被当作 500 INTERNAL_ERROR 处理。
    //   现将 SyntaxError 统一映射为 400 VALIDATION_ERROR，符合 HTTP 语义。
    //   - 涵盖三种情况：
    //     1. 原生 SyntaxError（JSON.parse 失败）
    //     2. Fastify 包装的 FST_ERR_FAILED_TO_PARSE_JSON_BODY（JSON 解析失败）
    //     3. FST_ERR_CTP_EMPTY_JSON_BODY（Content-Type: application/json 但 body 为空字符串）
    //   - 错误细节仅在非生产环境回传（避免泄露内部解析路径）
    if (
      err instanceof SyntaxError ||
      err.code === 'FST_ERR_FAILED_TO_PARSE_JSON_BODY' ||
      err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      logger.debug({ err, url: req.url, method: req.method, msg: '请求体 JSON 解析失败' });
      const message = env.NODE_ENV === 'production'
        ? '请求体格式不合法（无法解析为 JSON）'
        : `请求体格式不合法：${err.message}`;
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message,
        ...(req.id ? { traceId: req.id } : {}),
      });
    }

    // 第三期 M7：Fastify schema 校验错误 -> 400
    // P0 安全修复（中危10）：生产环境不回传 schemaPath/keyword/params 等内部
    //   schema 结构细节，仅回传字段路径与可读消息；完整细节写入日志供排查
    if (err.validation && (err.code === 'FST_ERR_VALIDATION' || err.name === 'FastifyError')) {
      const isProdEnv = env.NODE_ENV === 'production';
      const validationDetails = (err.validation ?? []).map((v: any) => ({
        path: v.instancePath || '',
        message: v.message,
        // 仅非生产环境附带 schema 内部结构，防止泄露 schema 用于构造攻击
        ...(isProdEnv
          ? {}
          : {
              schemaPath: v.schemaPath,
              keyword: v.keyword,
              params: v.params,
            }),
      }));
      // 生产环境也只回传通用提示，不暴露 err.message（可能含 schema 片段）
      const message = isProdEnv ? '请求参数校验失败' : err.message;
      // 完整细节写入日志
      logger.warn({
        msg: 'Fastify schema 校验失败',
        url: req.url,
        method: req.method,
        traceId: req.id,
        validation: err.validation,
      });
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message,
        details: validationDetails,
        ...(req.id ? { traceId: req.id } : {}),
      });
    }

    // 业务错误 -> 对应状态码
    if (err instanceof AppError) {
      const http = ERROR_HTTP_STATUS[err.code] ?? 500;
      const body: any = {
        error: err.code,
        message: err.message,
      };
      if (err.details) body.details = err.details;
      // 附带 trace_id（若请求中存在）
      if (req.id) body.traceId = req.id;
      return reply.code(http).send(body);
    }

    // 未知错误 -> 500，不泄露内部细节
    logger.error({ err, msg: '未处理异常', url: req.url, method: req.method });
    // M8 修复：原 env.NODE_ENV !== 'production' 在 development / test 模式下都会
    //   把 err.message 回传客户端。若误将 NODE_ENV=development 部署到公网，会泄露
    //   内部错误细节（如数据库连接串、文件路径）。改为仅 test 模式回传 detail。
    return reply.code(500).send({
      error: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      ...(env.NODE_ENV === 'test' ? { detail: err.message } : {}),
      ...(req.id ? { traceId: req.id } : {}),
    });
  });

  // 404 处理
  // P2-4：不返回 url（可能含 token query 参数），仅返回 method
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: 'NOT_FOUND',
      message: `路由不存在: ${req.method}`,
      ...(req.id ? { traceId: req.id } : {}),
    });
  });
});
