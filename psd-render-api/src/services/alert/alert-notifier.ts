/**
 * 告警通知器（第三期 M10）
 *
 * 职责：将 AlertEvent 主动推送到外部通知渠道
 *   - 通用 Webhook（POST JSON）
 *   - 飞书机器人
 *   - 钉钉机器人
 *
 * 设计原则：
 *   - fire-and-forget：不阻断告警创建主流程
 *   - 失败仅记录日志，不影响 AlertEvent 状态
 *   - 按 severity 过滤（ALERT_MIN_SEVERITY 控制触发级别）
 *   - 无重试机制（POC 简化；如需重试可后续接入 WebhookLog 模式）
 *
 * 各渠道 payload 格式参考：
 *   - 通用 Webhook：标准 JSON { title, message, severity, type, refId, triggeredAt }
 *   - 飞书：{ msg_type: 'text', content: { text: '...' } }
 *   - 钉钉：{ msgtype: 'text', text: { content: '...' } }
 */
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { validateWebhookUrlDynamic } from '../../lib/ssrf-guard.js';

/** 告警级别权重（用于 ALERT_MIN_SEVERITY 比较） */
const SEVERITY_WEIGHT: Record<string, number> = {
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  CRITICAL: 4,
};

export interface AlertNotifyPayload {
  type: string;
  severity: string;
  refType?: string | null;
  refId?: string | null;
  title: string;
  message: string;
  triggeredAt: Date;
}

/** 判断告警级别是否满足通知触发阈值 */
function shouldNotify(severity: string): boolean {
  const minWeight = SEVERITY_WEIGHT[env.ALERT_MIN_SEVERITY] ?? 2;
  const curWeight = SEVERITY_WEIGHT[severity] ?? 2;
  return curWeight >= minWeight;
}

/** 构造可读的纯文本告警内容 */
function buildText(p: AlertNotifyPayload): string {
  const lines = [
    `[PSD 渲染告警] ${p.title}`,
    `级别: ${p.severity}`,
    `类型: ${p.type}`,
    `说明: ${p.message}`,
  ];
  if (p.refType) lines.push(`关联: ${p.refType}/${p.refId ?? '-'}`);
  lines.push(`触发时间: ${p.triggeredAt.toISOString()}`);
  return lines.join('\n');
}

/**
 * 通用 HTTP POST，超时控制
 *
 * P0 安全修复：投递前先做 SSRF 动态校验（含 DNS 解析），防止 DNS rebinding
 *   绕过启动时静态校验。校验失败直接返回错误，不发起请求。
 */
async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status?: number; err?: string }> {
  // P0：动态 SSRF 校验（解析 DNS 后逐 IP 比对私有/保留段）
  const ssrfCheck = await validateWebhookUrlDynamic(url);
  if (!ssrfCheck.ok) {
    logger.warn({ url, reason: ssrfCheck.reason, msg: '告警通知 SSRF 拦截' });
    return { ok: false, err: `SSRF 拦截: ${ssrfCheck.reason}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e: any) {
    return { ok: false, err: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

class AlertNotifierService {
  /**
   * 异步分发通知到所有已配置的渠道
   * 失败仅记录日志，不抛出异常
   */
  notify(p: AlertNotifyPayload): void {
    if (!shouldNotify(p.severity)) {
      return;
    }
    // 并行发送到所有已配置渠道
    this.notifyGenericWebhook(p).catch((e) => {
      logger.warn({ err: e as Error, msg: '通用 Webhook 通知异常' });
    });
    this.notifyFeishu(p).catch((e) => {
      logger.warn({ err: e as Error, msg: '飞书通知异常' });
    });
    this.notifyDingTalk(p).catch((e) => {
      logger.warn({ err: e as Error, msg: '钉钉通知异常' });
    });
  }

  /** 通用 Webhook：POST 标准 JSON */
  private async notifyGenericWebhook(p: AlertNotifyPayload): Promise<void> {
    const url = env.ALERT_WEBHOOK_URL;
    if (!url) return;
    const body = {
      title: p.title,
      message: p.message,
      severity: p.severity,
      type: p.type,
      refType: p.refType ?? null,
      refId: p.refId ?? null,
      triggeredAt: p.triggeredAt.toISOString(),
    };
    const r = await postJson(url, body, env.ALERT_NOTIFY_TIMEOUT_MS);
    if (r.ok) {
      logger.info({ channel: 'webhook', status: r.status, type: p.type, msg: '告警已推送至通用 Webhook' });
    } else {
      logger.warn({ channel: 'webhook', status: r.status, err: r.err, type: p.type, msg: '通用 Webhook 推送失败' });
    }
  }

  /** 飞书机器人：text 消息 */
  private async notifyFeishu(p: AlertNotifyPayload): Promise<void> {
    const url = env.ALERT_FEISHU_WEBHOOK_URL;
    if (!url) return;
    const body = {
      msg_type: 'text',
      content: { text: buildText(p) },
    };
    const r = await postJson(url, body, env.ALERT_NOTIFY_TIMEOUT_MS);
    if (r.ok) {
      logger.info({ channel: 'feishu', status: r.status, type: p.type, msg: '告警已推送至飞书' });
    } else {
      logger.warn({ channel: 'feishu', status: r.status, err: r.err, type: p.type, msg: '飞书推送失败' });
    }
  }

  /** 钉钉机器人：text 消息 */
  private async notifyDingTalk(p: AlertNotifyPayload): Promise<void> {
    const url = env.ALERT_DINGTALK_WEBHOOK_URL;
    if (!url) return;
    const body = {
      msgtype: 'text',
      text: { content: buildText(p) },
    };
    const r = await postJson(url, body, env.ALERT_NOTIFY_TIMEOUT_MS);
    if (r.ok) {
      logger.info({ channel: 'dingtalk', status: r.status, type: p.type, msg: '告警已推送至钉钉' });
    } else {
      logger.warn({ channel: 'dingtalk', status: r.status, err: r.err, type: p.type, msg: '钉钉推送失败' });
    }
  }
}

export const alertNotifier = new AlertNotifierService();
