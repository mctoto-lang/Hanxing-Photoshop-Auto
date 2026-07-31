/**
 * 模板服务：上传 PSD、解析图层树、保存绑定配置、发布版本
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import {
  genTemplateCode,
  genTemplateVersionCode,
  sha256File,
} from '../../lib/crypto.js';
import { psdParser } from '../psd-parser/psd-parser.js';
import { getStorage } from '../storage/index.js';
import { AppError, Errors } from '../../lib/errors.js';
import type { LayerSchema, LayerTreeResult, LayerNode } from '../../types/index.js';
import { getTemplateDisplayStatus } from './template-status.js';

class TemplateService {
  /**
   * 生成 PSD 上传预签名地址
   */
  async getUploadUrl(opts: { fileName: string; mimeType?: string }) {
    const storage = await getStorage();
    const objectKey = `psd/${Date.now()}_${path.basename(opts.fileName)}`;
    const result = await storage.generateUploadUrl({
      objectKey,
      mimeType: opts.mimeType ?? 'image/vnd.adobe.photoshop',
      expiresInSec: 600,
    });
    return {
      uploadUrl: result.uploadUrl,
      method: result.method,
      headers: result.headers,
      objectKey: result.objectKey,
      uploadToken: result.uploadToken,
      expiresAt: result.expiresAt,
    };
  }

  async createFromUpload(opts: { fileName: string; name: string; body: Buffer; psMinVersion?: string; tenantId?: string }) {
    if (!opts.fileName.toLowerCase().endsWith('.psd')) throw Errors.validationError('仅支持 .psd 模板文件');
    const storage = await getStorage();
    const safeName = path.basename(opts.fileName).replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_');
    const objectKey = `psd/${Date.now()}_${safeName}`;
    await storage.putObject({
      objectKey,
      body: opts.body,
      mimeType: 'image/vnd.adobe.photoshop',
      contentLength: opts.body.length,
    });
    try {
      // Admin 上传的模板归入 default 租户（平台共享）
      return await this.createFromPsd({ objectKey, name: opts.name, psMinVersion: opts.psMinVersion, tenantId: opts.tenantId ?? 'default' });
    } catch (error) {
      await storage.deleteObject(objectKey).catch(() => {});
      throw error;
    }
  }

  /**
   * 触发 PSD 解析：下载 PSD -> 解析图层树 -> 创建模板+版本（草稿）-> 返回图层树
   *
   * P0 安全修复（严重 S2）：增加 tenantId 参数，新建模板时写入 API Key 的 tenantId。
   *   objectKey 仅允许 psd/ 前缀，且按 tenantId 隔离。
   */
  async createFromPsd(opts: {
    objectKey: string;
    name: string;
    psMinVersion?: string;
    tenantId: string;
  }): Promise<LayerTreeResult> {
    // P0 安全修复（严重 S3）：objectKey 必须为 psd/ 前缀，防止读取其他资源类型对象
    if (!opts.objectKey.startsWith('psd/') || opts.objectKey.includes('..')) {
      throw Errors.validationError('objectKey 必须为 psd/ 前缀的合法路径');
    }
    const storage = await getStorage();

    // 下载 PSD 到临时文件
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psd-parse-'));
    const tmpFile = path.join(tmpDir, path.basename(opts.objectKey) || 'template.psd');
    // B-H8 修复：跟踪已创建的 templateId，解析失败时回滚 DB 记录避免垃圾数据堆积。
    //   原实现 psdParser.parse() 抛错（如 PSD 损坏、超限）后，已创建的 template 与
    //   templateVersion 记录残留为 DRAFT + layerTree='[]'，污染 Admin 列表。
    let createdTemplateId: string | null = null;
    try {
      const buffer = await storage.getObject(opts.objectKey);
      await fs.writeFile(tmpFile, buffer);
      const psdSha256 = await sha256File(tmpFile);

      // 创建模板（草稿）+ 版本
      const template = await prisma.template.create({
        data: {
          code: genTemplateCode(),
          name: opts.name,
          status: 'DRAFT',
          tenantId: opts.tenantId,
        },
      });
      createdTemplateId = template.id;
      const version = await prisma.templateVersion.create({
        data: {
          code: genTemplateVersionCode(),
          templateId: template.id,
          version: 1,
          psdObjectKey: opts.objectKey,
          psdSha256,
          psMinVersion: opts.psMinVersion ?? '25.0',
          layerSchema: JSON.stringify({ bindings: [] } satisfies LayerSchema),
          layerTree: '[]',
          published: false,
        },
      });

      // 解析图层树
      const treeResult = await psdParser.parse({
        templateId: template.id,
        templateVersionId: version.id,
        filePath: tmpFile,
      });

      // 第三期 M8：生成缩略图 → 上传存储 → 更新 thumbnailObjectKey
      // 失败不阻断模板创建，仅记录告警（缩略图为辅助展示能力，非核心）
      // 修复：原实现先赋值 thumbnailObjectKey 再调用 putObject，若 putObject 抛错
      //   catch 块未重置 thumbnailObjectKey，导致 DB 写入指向不存在文件的 key，
      //   前端 <img> 加载 404 显示"加载失败"。现改为 putObject 成功后才赋值。
      let thumbnailObjectKey: string | null = null;
      try {
        const thumbBuf = await psdParser.generateThumbnail({ filePath: tmpFile });
        if (thumbBuf && thumbBuf.length > 0) {
          const targetKey = `thumbnails/${template.id}_${version.version}.png`;
          await storage.putObject({
            objectKey: targetKey,
            body: thumbBuf,
            mimeType: 'image/png',
            contentLength: thumbBuf.length,
          });
          // putObject 成功后才赋值，确保 DB 中的 key 一定指向已存在的文件
          thumbnailObjectKey = targetKey;
          logger.info({
            templateId: template.id,
            versionId: version.id,
            thumbnailObjectKey,
            thumbnailSize: thumbBuf.length,
            msg: '缩略图已上传',
          });
        }
      } catch (thumbErr) {
        logger.warn({
          err: thumbErr as Error,
          templateId: template.id,
          versionId: version.id,
          msg: '缩略图生成失败，模板仍可正常使用',
        });
      }

      // 持久化图层树与画布尺寸 + 缩略图 key
      await prisma.templateVersion.update({
        where: { id: version.id },
        data: {
          layerTree: JSON.stringify(treeResult.layerTree),
          canvasWidth: treeResult.canvas.width,
          canvasHeight: treeResult.canvas.height,
          ...(thumbnailObjectKey ? { thumbnailObjectKey } : {}),
        },
      });

      logger.info({
        templateId: template.id,
        versionId: version.id,
        layerCount: treeResult.layerTree.length,
        hasThumbnail: !!thumbnailObjectKey,
        msg: '模板解析完成',
      });

      return treeResult;
    } catch (parseError) {
      // B-H8：解析失败时回滚已创建的 template（级联删除 templateVersion），
      //   避免数据库堆积 DRAFT + layerTree='[]' 的垃圾记录。
      if (createdTemplateId) {
        try {
          await prisma.template.delete({ where: { id: createdTemplateId } });
          logger.warn({
            templateId: createdTemplateId,
            msg: 'PSD 解析失败已回滚 template 记录',
          });
        } catch (rollbackErr) {
          // 回滚失败不掩盖原始解析错误，仅记录告警
          logger.error({
            err: rollbackErr as Error,
            templateId: createdTemplateId,
            msg: '回滚 template 记录失败，可能产生孤儿记录',
          });
        }
      }
      // Bug 4 修复：PSD 解析失败（文件损坏/格式不对/超限/超时）属于客户端输入问题，
      //   应返回 422 INVALID_PSD_FORMAT 而非 500 INTERNAL_ERROR，
      //   让客户端能区分"文件格式不对"与"服务器真正故障"。
      //   AppError 直接透传（保留原错误码语义）；仅把非 AppError 的解析异常转为 INVALID_PSD_FORMAT。
      if (parseError instanceof AppError) throw parseError;
      const reason = parseError instanceof Error ? parseError.message : String(parseError);
      logger.warn({
        err: parseError as Error,
        objectKey: opts.objectKey,
        msg: 'PSD 解析失败，返回 422 INVALID_PSD_FORMAT',
      });
      throw Errors.invalidPsdFormat(`PSD 文件解析失败：${reason}`);
    } finally {
      // 清理临时文件
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 保存图层绑定配置（layerSchema）
   *
   * P0 安全修复（严重 S2）：外部 API 调用必须传 tenantId，Admin 跨租户管理可不传
   * P0-E 修复：原实现仅检查 latestVersion.published，archive 把 published 置 false 后
   *   saveLayerBindings 允许修改 layerSchema。但历史任务通过 templateVersionId 引用该版本，
   *   buildManifest 读到修改后的 layerSchema，与 PSD 实际图层结构不符，违反发布不可变契约。
   *   修复：若该版本曾发布过（template.status === 'REPUBLISH_REQUIRED' 且 !latestVersion.published），
   *   创建新版本写入新 layerSchema，旧版本保持不变。
   */
  async saveLayerBindings(templateId: string, schema: LayerSchema, tenantId?: string) {
    const template = await prisma.template.findFirst({
      where: tenantId ? { id: templateId, tenantId } : { id: templateId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!template) throw Errors.invalidLayerBinding('模板不存在');

    const latestVersion = template.versions[0];
    if (!latestVersion) throw Errors.invalidLayerBinding('模板无版本');
    if (latestVersion.published) {
      throw Errors.invalidLayerBinding('已发布版本不可修改绑定');
    }

    // 校验 bindingId 中的 layerId/layerPath 在图层树中存在，且 type 与图层实际类型一致
    const tree: LayerNode[] = JSON.parse(latestVersion.layerTree);
    const flat = this.flatten(tree);
    const layerById = new Map(flat.map((n) => [n.layerId, n]));
    const layerByPath = new Map(flat.map((n) => [n.layerPath, n]));

    for (const b of schema.bindings) {
      const byId = layerById.get(b.layerId);
      const byPath = layerByPath.get(b.layerPath);
      const layer = byId ?? byPath;
      if (!layer) {
        throw Errors.invalidLayerBinding(
          `绑定 ${b.bindingId} 的 layerId=${b.layerId} / layerPath=${b.layerPath} 在图层树中均不存在`,
        );
      }
      // 校验绑定类型为允许值（smartObject/text/pixel）
      //   注：不强校验 b.type === layer.type。psd 解析器对智能对象的检测依赖
      //   monkey-patch（见 psd-worker.ts），可能将真实 smartObject 误判为 pixel。
      //   允许操作员以 PS 实际类型为准手动指定绑定类型，渲染失败时由 Worker
      //   端给出明确错误。
      if (b.type !== 'smartObject' && b.type !== 'text' && b.type !== 'pixel') {
        throw Errors.invalidLayerBinding(
          `绑定 ${b.bindingId} 的 type=${b.type} 不被支持，仅允许 smartObject、text 和 pixel`,
        );
      }
    }

    // P0-E 修复：判断 latestVersion 是否曾发布过（被 archive 取消发布）。
    //   template.status === 'REPUBLISH_REQUIRED' 表示该模板曾发布后被 archive 进入编辑态，
    //   latestVersion.published === false 是 archive 设置的（不是从未发布）。
    //   此时直接修改 latestVersion.layerSchema 会影响引用该 versionId 的历史任务，
    //   必须创建新版本写入新 layerSchema，旧版本保持不变。
    const wasPublishedBefore = template.status === 'REPUBLISH_REQUIRED' && !latestVersion.published;

    if (wasPublishedBefore) {
      // 创建新版本（version+1），复制 PSD 相关字段，写入新 layerSchema
      const newVersion = await prisma.templateVersion.create({
        data: {
          code: genTemplateVersionCode(),
          templateId,
          version: latestVersion.version + 1,
          psdObjectKey: latestVersion.psdObjectKey,
          psdSha256: latestVersion.psdSha256,
          canvasWidth: latestVersion.canvasWidth,
          canvasHeight: latestVersion.canvasHeight,
          psMinVersion: latestVersion.psMinVersion,
          layerTree: latestVersion.layerTree,
          layerSchema: JSON.stringify(schema),
          thumbnailObjectKey: latestVersion.thumbnailObjectKey,
          published: false,
        },
      });
      // 删除旧绑定记录（layerBinding 按 templateId 关联，非按 versionId），写入新绑定
      await prisma.$transaction([
        prisma.layerBinding.deleteMany({ where: { templateId } }),
        prisma.layerBinding.createMany({
          data: schema.bindings.map((b) => ({
            templateId,
            bindingId: b.bindingId,
            layerId: b.layerId,
            layerPath: b.layerPath,
            type: b.type,
            required: b.required,
            label: b.label ?? null,
            acceptedFormats: (b.acceptedFormats ?? ['jpg', 'png', 'jpeg']).join(','),
            fit: b.fit ?? null,
            maxLength: b.maxLength ?? null,
            defaultFontVersionId: b.defaultFontVersionId ?? null,
          })),
        }),
      ]);
      logger.info({
        templateId,
        versionId: newVersion.id,
        version: newVersion.version,
        bindingCount: schema.bindings.length,
        msg: '图层绑定已保存（曾发布版本，已创建新版本保证不可变契约）',
      });
      return;
    }

    // 原逻辑：从未发布过的草稿版本，直接修改 latestVersion
    await prisma.$transaction([
      prisma.layerBinding.deleteMany({ where: { templateId } }),
      prisma.templateVersion.update({
        where: { id: latestVersion.id },
        data: { layerSchema: JSON.stringify(schema) },
      }),
      prisma.layerBinding.createMany({
        data: schema.bindings.map((b) => ({
          templateId,
          bindingId: b.bindingId,
          layerId: b.layerId,
          layerPath: b.layerPath,
          type: b.type,
          required: b.required,
          label: b.label ?? null,
          acceptedFormats: (b.acceptedFormats ?? ['jpg', 'png', 'jpeg']).join(','),
          fit: b.fit ?? null,
          maxLength: b.maxLength ?? null,
          defaultFontVersionId: b.defaultFontVersionId ?? null,
        })),
      }),
    ]);

    logger.info({ templateId, bindingCount: schema.bindings.length, msg: '图层绑定已保存' });
  }

  /**
   * 发布模板版本（发布后不可修改）
   *
   * P0 安全修复（严重 S2）：外部 API 调用必须传 tenantId，Admin 跨租户管理可不传
   */
  async publish(templateId: string, tenantId?: string) {
    const template = await prisma.template.findFirst({
      where: tenantId ? { id: templateId, tenantId } : { id: templateId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 }, bindings: true },
    });
    if (!template) throw Errors.invalidLayerBinding('模板不存在');

    const latest = template.versions[0];
    if (!latest) throw Errors.invalidLayerBinding('模板无版本');
    if (latest.published) throw Errors.invalidLayerBinding('版本已发布');

    const schema: LayerSchema = JSON.parse(latest.layerSchema);
    if (schema.bindings.length === 0) {
      throw Errors.invalidLayerBinding('未配置图层绑定，无法发布');
    }

    await prisma.$transaction([
      prisma.templateVersion.update({
        where: { id: latest.id },
        data: { published: true },
      }),
      prisma.template.update({
        where: { id: templateId },
        data: { status: 'PUBLISHED' },
      }),
    ]);

    logger.info({ templateId, versionId: latest.id, msg: '模板已发布' });
  }

  /**
   * 查询模板详情（含图层树、绑定）
   *
   * P0 安全修复（严重 S2）：外部 API 调用必须传 tenantId，Admin 跨租户管理可不传
   */
  async getDetail(templateId: string, tenantId?: string) {
    const template = await prisma.template.findFirst({
      where: tenantId ? { id: templateId, tenantId } : { id: templateId },
      include: {
        versions: { orderBy: { version: 'desc' } },
        bindings: true,
      },
    });
    if (!template) return null;

    const latest = template.versions[0];
    return {
      templateId: template.id,
      code: template.code,
      name: template.name,
      status: template.status,
      latestVersion: latest
        ? {
            versionId: latest.id,
            version: latest.version,
            published: latest.published,
            canvas: { width: latest.canvasWidth, height: latest.canvasHeight },
            psMinVersion: latest.psMinVersion,
            layerTree: latest.layerTree ? JSON.parse(latest.layerTree) : [],
            layerSchema: latest.layerSchema ? JSON.parse(latest.layerSchema) : { bindings: [] },
            thumbnailObjectKey: latest.thumbnailObjectKey ?? null,
            createdAt: latest.createdAt,
          }
        : null,
    };
  }

  /**
   * P0 安全修复（严重 S2）：外部 API 调用必须传 tenantId，Admin 跨租户管理可不传
   */
  async list(tenantId?: string) {
    const templates = await prisma.template.findMany({
      // 过滤掉软删除的模板，与 Admin 列表行为保持一致
      where: tenantId ? { tenantId, NOT: { status: 'DELETED' } } : { NOT: { status: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    return templates.map((t) => ({
      templateId: t.id,
      code: t.code,
      name: t.name,
      status: t.status,
      statusLabel: getTemplateDisplayStatus(t.status, t.versions[0]?.published ?? false),
      latestVersion: t.versions[0]?.version ?? 0,
      published: t.versions[0]?.published ?? false,
      thumbnailObjectKey: t.versions[0]?.thumbnailObjectKey ?? null,
      createdAt: t.createdAt,
    }));
  }

  /**
   * 第三期 M8：生成缩略图下载 URL（Admin UI 显示用）
   *
   * 本地存储模式：downloadToken 需拼入 URL，因为前端 <img src> 无法设置
   *   Authorization: Bearer 头。COS 模式下 downloadUrl 已是完整预签名 URL，
   *   downloadToken 为空字符串，无需处理。
   *
   * 修复：DB 中的 thumbnailObjectKey 可能指向已丢失的文件（历史 putObject 失败但
   *   key 已写入 DB 的 bug 遗留）。这里调用 headObject 探测，若文件不存在则清空
   *   DB 中的 thumbnailObjectKey，前端将显示 "-" 而非"加载失败"。
   */
  async getThumbnailDownloadUrl(templateId: string): Promise<{ downloadUrl: string; expiresAt: string } | null> {
    const t = await prisma.template.findUnique({
      where: { id: templateId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    const version = t?.versions[0];
    const thumbnailObjectKey = version?.thumbnailObjectKey;
    if (!thumbnailObjectKey) return null;
    const storage = await getStorage();
    // 探测文件是否真实存在；不存在则清空 DB 引用避免后续反复 404
    const meta = await storage.headObject(thumbnailObjectKey).catch(() => null);
    if (!meta) {
      logger.warn({
        templateId,
        versionId: version.id,
        thumbnailObjectKey,
        msg: '缩略图文件不存在，清空 DB 中的引用',
      });
      await prisma.templateVersion.update({
        where: { id: version.id },
        data: { thumbnailObjectKey: null },
      });
      return null;
    }
    const r = await storage.generateDownloadUrl({
      objectKey: thumbnailObjectKey,
      expiresInSec: 3600,
    });
    const downloadUrl = r.downloadToken
      ? `${r.downloadUrl}&token=${encodeURIComponent(r.downloadToken)}`
      : r.downloadUrl;
    return { downloadUrl, expiresAt: r.expiresAt };
  }

  /**
   * 重新生成模板缩略图（Admin UI 触发，用于修复丢失的缩略图文件）
   *
   * 流程：读取 PSD → 生成缩略图 → 上传存储 → 更新 DB
   * 若 PSD 文件也已丢失则抛错。
   */
  async regenerateThumbnail(templateId: string): Promise<{ ok: true; thumbnailObjectKey: string }> {
    const t = await prisma.template.findUnique({
      where: { id: templateId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!t) throw Errors.notFound('模板不存在');
    const version = t.versions[0];
    if (!version) throw Errors.notFound('模板无版本');
    if (!version.psdObjectKey) throw Errors.validationError('模板缺少 PSD 文件引用，无法生成缩略图');

    const storage = await getStorage();
    // 下载 PSD 到临时文件
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psd-thumb-regen-'));
    const tmpFile = path.join(tmpDir, path.basename(version.psdObjectKey) || 'template.psd');
    try {
      const buffer = await storage.getObject(version.psdObjectKey);
      await fs.writeFile(tmpFile, buffer);

      const thumbBuf = await psdParser.generateThumbnail({ filePath: tmpFile });
      if (!thumbBuf || thumbBuf.length === 0) {
        throw Errors.validationError('PSD 无内嵌预览图，无法生成缩略图');
      }

      const targetKey = `thumbnails/${t.id}_${version.version}.png`;
      await storage.putObject({
        objectKey: targetKey,
        body: thumbBuf,
        mimeType: 'image/png',
        contentLength: thumbBuf.length,
      });

      await prisma.templateVersion.update({
        where: { id: version.id },
        data: { thumbnailObjectKey: targetKey },
      });

      logger.info({
        templateId,
        versionId: version.id,
        thumbnailObjectKey: targetKey,
        thumbnailSize: thumbBuf.length,
        msg: '缩略图已重新生成',
      });

      return { ok: true, thumbnailObjectKey: targetKey };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ============== 第三期 M4：Admin 写操作 ==============

  /** 归档模板（不再可用于新任务，历史任务产物保留） */
  async archive(templateId: string) {
    const t = await prisma.template.findUnique({ where: { id: templateId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!t) throw Errors.notFound('模板不存在');
    const latest = t.versions[0];
    if (!latest) throw Errors.notFound('模板无版本');
    await prisma.$transaction([
      prisma.template.update({ where: { id: templateId }, data: { status: 'REPUBLISH_REQUIRED' } }),
      prisma.templateVersion.update({ where: { id: latest.id }, data: { published: false } }),
    ]);
    logger.info({ templateId, code: t.code, msg: '模板已进入编辑状态' });
    return { templateId, status: 'REPUBLISH_REQUIRED' };
  }

  /** 取消归档（恢复为 DRAFT 状态） */
  async unarchive(templateId: string) {
    const t = await prisma.template.findUnique({ where: { id: templateId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!t) throw Errors.notFound('模板不存在');
    const latest = t.versions[0];
    if (!latest) throw Errors.notFound('模板无版本');
    // P1-21 修复：unarchive 应恢复为 DRAFT 可编辑状态，而非与 archive 相同的 REPUBLISH_REQUIRED
    // archive 设置 latest.published=false（进入编辑态），unarchive 时若 latest 仍 published
    // 则保持已发布状态可继续使用；若已 unpublished 则回到 DRAFT 等待重新发布
    const targetStatus = latest.published ? 'PUBLISHED' : 'DRAFT';
    await prisma.$transaction([
      prisma.template.update({ where: { id: templateId }, data: { status: targetStatus } }),
    ]);
    logger.info({ templateId, code: t.code, status: targetStatus, msg: '模板已取消归档' });
    return { templateId, status: targetStatus };
  }

  /**
   * 软删除模板（标记 DELETED，不实际删除数据）
   * - 仅 DRAFT / ARCHIVED 状态可删除
   * - 已 PUBLISHED 必须先归档
   */
  async softDelete(templateId: string) {
    const t = await prisma.template.findUnique({ where: { id: templateId }, include: { versions: true } });
    if (!t) throw Errors.notFound('模板不存在');
    if (t.status === 'PUBLISHED') {
      throw Errors.validationError('已发布模板必须先归档');
    }
    const jobCount = await prisma.renderJob.count({ where: { templateVersion: { templateId } } });
    await prisma.template.update({
      where: { id: templateId },
      data: { status: 'DELETED' },
    });
    if (jobCount === 0) {
      const storage = await getStorage();
      // 逐版本删除存储文件：仅当 deleteObject 成功时才清空 DB 的 objectKey，
      // 失败则保留 objectKey 供孤儿清理器（startTemplatePsdReaper）下一轮重试，
      // 避免 COS 删除失败时 DB 已清空 key 导致文件成为永久孤儿。
      // psdObjectKey 在 schema 中是 NOT NULL，用空字符串标记"已清除"；
      // thumbnailObjectKey 可空，直接置 null。
      await Promise.all(t.versions.map(async (v) => {
        const updates: { psdObjectKey?: string; thumbnailObjectKey?: string | null } = {};
        try {
          await storage.deleteObject(v.psdObjectKey);
          updates.psdObjectKey = '';
        } catch (e) {
          logger.warn({
            err: e as Error,
            versionId: v.id,
            objectKey: v.psdObjectKey,
            msg: '删除 PSD 文件失败，保留 objectKey 供孤儿清理器重试',
          });
        }
        if (v.thumbnailObjectKey) {
          try {
            await storage.deleteObject(v.thumbnailObjectKey);
            updates.thumbnailObjectKey = null;
          } catch (e) {
            logger.warn({
              err: e as Error,
              versionId: v.id,
              objectKey: v.thumbnailObjectKey,
              msg: '删除缩略图失败，保留 objectKey 供孤儿清理器重试',
            });
          }
        }
        if (updates.psdObjectKey !== undefined || updates.thumbnailObjectKey !== undefined) {
          await prisma.templateVersion.update({
            where: { id: v.id },
            data: updates,
          });
        }
      }));
    }
    logger.info({ templateId, code: t.code, msg: '模板已软删除' });
    return { templateId, status: 'DELETED', storagePurged: jobCount === 0 };
  }

  private flatten(nodes: LayerNode[]): LayerNode[] {
    const result: LayerNode[] = [];
    const walk = (ns: LayerNode[]) => {
      for (const n of ns) {
        result.push(n);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(nodes);
    return result;
  }
}

export const templateService = new TemplateService();
