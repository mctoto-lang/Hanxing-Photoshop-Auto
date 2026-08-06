/**
 * 字体服务：上传字体、发布、生成清单
 */
import path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { genFontCode, sha256File } from '../../lib/crypto.js';
import { getStorage } from '../storage/index.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { fontInstaller, type InstallResult } from './font-installer.js';

class FontService {
  async getUploadUrl(opts: { fileName: string; mimeType?: string }) {
    const storage = await getStorage();
    const ext = path.extname(opts.fileName).toLowerCase();
    const objectKey = `fonts/${Date.now()}_${path.basename(opts.fileName)}`;
    const mimeType =
      opts.mimeType ?? (ext === '.ttf' ? 'font/ttf' : ext === '.otf' ? 'font/otf' : 'font/otf');
    const result = await storage.generateUploadUrl({
      objectKey,
      mimeType,
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

  /**
   * 注册字体（上传完成后调用，记录元数据）
   *
   * P0 安全修复（高危6）：Worker 通过 /internal/fonts/register 调用时,
   *   原实现信任 Worker 自报的 sha256 与 familyName/postscriptName,且不校验
   *   objectKey 是否为字体文件。恶意 Worker 可将 PSD 等非字体对象注册为字体,
   *   诱导其他 Worker 下载,造成数据混淆。
   *
   *   修复策略:
   *   1. 后端重新拉取 objectKey 内容并计算 sha256(不复用 Worker 自报值)
   *   2. 若 Worker 提供了 sha256, 比对不一致则拒绝注册
   *   3. 用 fontkit 解析验证为合法字体文件
   *   4. 解析得到的 familyName/postscriptName 与入参一致性校验(不一致则警告但不阻断,
   *      以入参为准——避免合法字体因版本差异被拒)
   *
   * P1-A 修复（字体投毒防护）：
   *   原实现"不一致仅警告以入参为准"存在字体投毒风险：恶意 Worker 可上传伪装成 Arial
   *   的恶意字体，后端以 Arial 名义注册，其他 Worker 同步 manifest 下载该"Arial"后
   *   PS 渲染时实际渲染出恶意字体内容，被静默篡改且 sha256 一致无法发现。
   *   现改为：元数据不一致直接拒绝注册（以 fontkit 解析值为准）。
   *   existing 更新前比对 sha256，不一致则拒绝（防止覆盖已发布字体）。
   */
  async register(opts: {
    objectKey: string;
    familyName: string;
    postscriptName: string;
    style?: string;
    sha256?: string;
    licenseNote?: string;
  }) {
    const storage = await getStorage();

    // P1-A：字体文件大小校验（50MB 上限），防止 getObject 把超大文件全量读入内存 OOM
    const headMeta = await storage.headObject(opts.objectKey);
    if (headMeta && headMeta.size > 50 * 1024 * 1024) {
      throw Errors.validationError(
        `字体文件超过 50MB 限制（实际 ${headMeta.size} 字节）`,
      );
    }

    // P0：后端重新拉取对象并计算 sha256，不复用 Worker 自报值
    const buffer = await storage.getObject(opts.objectKey);
    if (!buffer || buffer.length === 0) {
      throw Errors.validationError(`字体对象内容为空: ${opts.objectKey}`);
    }
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(buffer).digest('hex');

    // P0：若调用方提供了 sha256，比对不一致则拒绝（防止 Worker 谎报）
    if (opts.sha256 && opts.sha256 !== sha) {
      logger.warn({
        objectKey: opts.objectKey,
        claimedSha256: opts.sha256,
        actualSha256: sha,
        msg: '字体注册 SHA256 不一致，已拒绝',
      });
      throw Errors.validationError(
        `字体 SHA256 校验失败: 后端实际值与 Worker 自报值不一致（objectKey=${opts.objectKey}）`,
      );
    }

    // P0：用 fontkit 验证为合法字体文件，防止 PSD/HTML 等被注册为字体
    const meta = await this.parseFontMetadata(buffer);
    // P1-A 修复：元数据不一致直接拒绝注册（原仅警告以入参为准，存在字体投毒风险）
    //   恶意 Worker 可上传伪装成 Arial 的恶意字体，后端以 Arial 名义注册，
    //   其他 Worker 同步下载后渲染结果被静默篡改，且 sha256 一致无法发现。
    if (meta.familyName !== opts.familyName || meta.postscriptName !== opts.postscriptName) {
      logger.warn({
        objectKey: opts.objectKey,
        claimedFamily: opts.familyName,
        actualFamily: meta.familyName,
        claimedPostscript: opts.postscriptName,
        actualPostscript: meta.postscriptName,
        msg: '字体元数据与自报值不一致，已拒绝注册（防字体投毒）',
      });
      throw Errors.validationError(
        `字体元数据校验失败: 自报 familyName=${opts.familyName}/postscriptName=${opts.postscriptName}，` +
        `fontkit 解析实际为 familyName=${meta.familyName}/postscriptName=${meta.postscriptName}（疑似字体投毒）`,
      );
    }

    const existing = await prisma.fontVersion.findUnique({
      where: {
        postscriptName_style: {
          postscriptName: opts.postscriptName,
          style: opts.style ?? 'Regular',
        },
      },
    });
    // M9：许可证必填模式下，无 licenseNote 不自动发布
    const shouldAutoPublish = env.FONT_LICENSE_REQUIRED
      ? !!(opts.licenseNote && opts.licenseNote.trim())
      : true;
    if (existing) {
      // P1-A 修复：existing 更新前比对 sha256，防止覆盖已发布字体（字体供应链攻击）
      //   原 update 无 sha256 比对，被攻破的 Worker 可上传伪装字体覆盖 existing 记录，
      //   所有 Worker 下次同步 manifest 时下载到恶意字体，渲染被篡改。
      if (existing.sha256 && existing.sha256 !== sha && existing.published) {
        logger.warn({
          fontId: existing.id,
          postscriptName: opts.postscriptName,
          existingSha256: existing.sha256,
          newSha256: sha,
          msg: '已发布字体的 sha256 与新文件不一致，已拒绝覆盖（防供应链攻击）',
        });
        throw Errors.validationError(
          `字体 ${opts.postscriptName} 已发布且与新上传文件 sha256 不一致。` +
          `为防止供应链攻击，不允许直接覆盖已发布字体，请先删除旧字体或使用不同 postscriptName。`,
        );
      }
      // sha256 一致则无需更新（字体内容未变化）
      if (existing.sha256 === sha) {
        logger.info({
          fontId: existing.id,
          postscriptName: opts.postscriptName,
          msg: '字体文件 sha256 与已有记录一致，跳过更新',
        });
        return existing;
      }
      // 更新文件引用
      const updated = await prisma.fontVersion.update({
        where: { id: existing.id },
        data: {
          fileObjectKey: opts.objectKey,
          sha256: sha,
          licenseNote: opts.licenseNote ?? existing.licenseNote,
          // 若之前未发布且现在有 licenseNote，则自动发布；否则保持原状态
          published: !existing.published && shouldAutoPublish ? true : existing.published,
        },
      });
      logger.info({
        fontId: updated.id,
        postscriptName: opts.postscriptName,
        published: updated.published,
        msg: '字体已更新',
      });
      return updated;
    }

    const font = await prisma.fontVersion.create({
      data: {
        code: genFontCode(),
        familyName: opts.familyName,
        postscriptName: opts.postscriptName,
        style: opts.style ?? 'Regular',
        fileObjectKey: opts.objectKey,
        sha256: sha,
        licenseNote: opts.licenseNote,
        published: shouldAutoPublish,
      },
    });
    logger.info({
      fontId: font.id,
      postscriptName: opts.postscriptName,
      published: font.published,
      msg: '字体已注册',
    });
    return font;
  }

  /**
   * 全量字体清单（供 Worker 空闲同步使用）
   * 返回 sha256、fileUrl、postscriptName、style 列表及清单哈希
   */
  async getManifest() {
    const fonts = await prisma.fontVersion.findMany({
      where: { published: true },
      orderBy: { familyName: 'asc' },
    });
    const storage = await getStorage();
    // P1-16 修复：并行生成下载 URL，原串行 for-await 在 100+ 字体时
    // 会串行触发 COS 签名计算，Worker 字体同步被阻塞数秒
    // P2-D：downloadToken 单独返回，Worker 通过 Authorization: Bearer 头携带
    const items = await Promise.all(
      fonts.map(async (f) => {
        const dl = await storage.generateDownloadUrl({
          objectKey: f.fileObjectKey,
          expiresInSec: 3600,
        });
        return {
          postscriptName: f.postscriptName,
          familyName: f.familyName,
          style: f.style,
          sha256: f.sha256,
          fileUrl: dl.downloadUrl,
          fileToken: dl.downloadToken ?? '',
        };
      }),
    );
    // 清单哈希：所有字体 sha256 排序后拼接的哈希
    const concat = items
      .map((i) => i.sha256)
      .sort()
      .join('');
    const { createHash } = await import('node:crypto');
    const inventoryHash = createHash('sha256').update(concat).digest('hex');

    return { fonts: items, inventoryHash, count: items.length };
  }

  async list() {
    const fonts = await prisma.fontVersion.findMany({
      orderBy: { familyName: 'asc' },
    });
    return fonts.map((f) => ({
      fontId: f.id,
      code: f.code,
      familyName: f.familyName,
      postscriptName: f.postscriptName,
      style: f.style,
      sha256: f.sha256,
      published: f.published,
      licenseNote: f.licenseNote,
      createdAt: f.createdAt,
    }));
  }

  async getFallbackConfig() {
    const config = await prisma.fontConfig.findUnique({
      where: { id: 1 },
      include: { fallbackFontVersion: true },
    });
    const font = config?.fallbackFontVersion ?? null;
    return {
      fallbackFontVersionId: font?.id ?? null,
      fallbackFont: font ? {
        fontId: font.id,
        familyName: font.familyName,
        postscriptName: font.postscriptName,
        style: font.style,
        published: font.published,
      } : null,
    };
  }

  async setFallbackFont(fallbackFontVersionId: string | null) {
    if (fallbackFontVersionId) {
      const font = await prisma.fontVersion.findUnique({ where: { id: fallbackFontVersionId } });
      if (!font) throw Errors.notFound('字体不存在');
      if (!font.published) throw Errors.validationError('全局兜底字体必须是已发布字体');
    }
    await prisma.fontConfig.upsert({
      where: { id: 1 },
      create: { id: 1, fallbackFontVersionId },
      update: { fallbackFontVersionId },
    });
    return this.getFallbackConfig();
  }

  // ============== 第三期 M4：Admin 写操作 ==============

  /** 启用/禁用字体（影响 Worker 字体清单同步） */
  async setPublished(fontVersionId: string, published: boolean) {
    const font = await prisma.fontVersion.findUnique({
      where: { id: fontVersionId },
    });
    if (!font) throw Errors.notFound('字体不存在');
    // M9：启用（发布）时若强制要求许可证，必须先设置 licenseNote
    if (published && env.FONT_LICENSE_REQUIRED && (!font.licenseNote || !font.licenseNote.trim())) {
      throw Errors.validationError(
        `字体 ${font.postscriptName} 未设置许可证备注（licenseNote），无法启用。请先编辑许可证信息。`,
      );
    }
    if (!published) {
      const [refCount, config] = await Promise.all([
        prisma.layerBinding.count({ where: { defaultFontVersionId: fontVersionId } }),
        prisma.fontConfig.findFirst({ where: { fallbackFontVersionId: fontVersionId } }),
      ]);
      if (refCount > 0) {
        throw Errors.validationError(
          `字体 ${font.postscriptName} 被 ${refCount} 个图层绑定引用，请先解除引用后再禁用`,
        );
      }
      if (config) {
        throw Errors.validationError(`字体 ${font.postscriptName} 是全局兜底字体，请先取消全局兜底配置后再禁用`);
      }
    }
    await prisma.fontVersion.update({
      where: { id: fontVersionId },
      data: { published },
    });
    logger.info({
      fontId: fontVersionId,
      postscriptName: font.postscriptName,
      published,
      msg: '字体发布状态变更',
    });
    return { fontId: fontVersionId, published };
  }

  /** 编辑字体许可证备注 */
  async updateLicenseNote(fontVersionId: string, licenseNote: string | null) {
    const font = await prisma.fontVersion.findUnique({
      where: { id: fontVersionId },
    });
    if (!font) throw Errors.notFound('字体不存在');
    await prisma.fontVersion.update({
      where: { id: fontVersionId },
      data: { licenseNote },
    });
    logger.info({
      fontId: fontVersionId,
      postscriptName: font.postscriptName,
      msg: '字体许可证备注已更新',
    });
    return { fontId: fontVersionId, licenseNote };
  }

  /** 字体详情 */
  async getDetail(fontVersionId: string) {
    const font = await prisma.fontVersion.findUnique({
      where: { id: fontVersionId },
    });
    if (!font) return null;
    return {
      fontId: font.id,
      code: font.code,
      familyName: font.familyName,
      postscriptName: font.postscriptName,
      style: font.style,
      fileObjectKey: font.fileObjectKey,
      sha256: font.sha256,
      licenseNote: font.licenseNote,
      published: font.published,
      createdAt: font.createdAt,
    };
  }

  /**
   * 删除字体（硬删除）
   * - 阻断式：若被任何 LayerBinding.defaultFontVersionId 引用，直接抛错
   * - 同步卸载本机系统字体（fontInstaller.uninstall）
   * - 同步清理对象存储中的字体文件（storage.deleteObject）
   * - 删除 FontVersion 记录
   *
   * 字体文件名从 fileObjectKey 末段推导（与 uploadAndRegister 的 safeName 一致）
   */
  async delete(fontVersionId: string, operator: string): Promise<{
    fontId: string;
    familyName: string;
    postscriptName: string;
    storagePurged: boolean;
    systemUninstalled: boolean;
    deleted: boolean;
  }> {
    const font = await prisma.fontVersion.findUnique({
      where: { id: fontVersionId },
    });
    if (!font) throw Errors.notFound('字体不存在');

    // 1. 阻断式检查：是否被任何图层绑定引用
    const refCount = await prisma.layerBinding.count({
      where: { defaultFontVersionId: fontVersionId },
    });
    if (refCount > 0) {
      throw Errors.validationError(
        `字体 ${font.postscriptName} 被 ${refCount} 个图层绑定引用，请先在模板绑定编辑器中解除引用后再删除`,
      );
    }
    const fallbackRef = await prisma.fontConfig.findFirst({
      where: { fallbackFontVersionId: fontVersionId },
    });
    if (fallbackRef) {
      throw Errors.validationError(
        `字体 ${font.postscriptName} 是全局兜底字体，请先取消全局兜底配置后再删除`,
      );
    }

    // 2. 卸载本机系统字体（从 fileObjectKey 末段推导字体文件名）
    //    fileObjectKey 格式：fonts/{timestamp}_{safeName}，末段即 safeName
    const fontFileName = path.basename(font.fileObjectKey);
    let systemUninstalled = false;
    try {
      systemUninstalled = await fontInstaller.uninstall(fontFileName);
    } catch (e) {
      logger.warn({
        fontId: fontVersionId,
        fontFileName,
        msg: '卸载系统字体失败（不影响 DB 删除）',
        err: (e as Error).message,
      });
    }

    // 3. 清理对象存储中的字体文件
    const storage = await getStorage();
    let storagePurged = false;
    try {
      await storage.deleteObject(font.fileObjectKey);
      storagePurged = true;
    } catch (e) {
      logger.warn({
        fontId: fontVersionId,
        objectKey: font.fileObjectKey,
        msg: '清理对象存储字体文件失败（不影响 DB 删除）',
        err: (e as Error).message,
      });
    }

    // 4. 删除 FontVersion 记录
    await prisma.fontVersion.delete({ where: { id: fontVersionId } });

    logger.info({
      fontId: fontVersionId,
      postscriptName: font.postscriptName,
      operator,
      storagePurged,
      systemUninstalled,
      msg: '字体已删除',
    });

    return {
      fontId: fontVersionId,
      familyName: font.familyName,
      postscriptName: font.postscriptName,
      storagePurged,
      systemUninstalled,
      deleted: true,
    };
  }

  /**
   * 一站式上传：存储 + fontkit 解析元数据 + 立即安装到本机 + 写入 DB
   *
   * 流程：
   *   1. 校验文件类型与大小
   *   2. 用 fontkit 解析字体元数据（familyName / postscriptName / style）
   *   3. 计算 sha256
   *   4. 存储到对象存储（fonts/ 前缀）
   *   5. 写入临时文件，调用 fontInstaller.install 立即安装到系统
   *   6. 调用 register 写入 FontVersion 表
   *   7. 清理临时文件
   *
   * @returns FontVersion 记录（含 fontId）
   */
  async uploadAndRegister(opts: {
    fileName: string;
    buffer: Buffer;
    mimeType?: string;
    licenseNote?: string;
  }): Promise<{
    fontId: string;
    code: string;
    familyName: string;
    postscriptName: string;
    style: string;
    published: boolean;
    installed: boolean;
    installMessage?: string;
  }> {
    const { fileName, buffer } = opts;

    // 1. 校验文件类型
    const ext = path.extname(fileName).toLowerCase();
    if (!['.ttf', '.otf', '.ttc'].includes(ext)) {
      throw Errors.validationError(`不支持的字体格式: ${ext}（仅支持 .ttf/.otf/.ttc）`);
    }
    if (buffer.length === 0) {
      throw Errors.validationError('字体文件内容为空');
    }
    if (buffer.length > 50 * 1024 * 1024) {
      throw Errors.validationError('字体文件超过 50MB 限制');
    }

    // 2. 用 fontkit 解析字体元数据
    const meta = await this.parseFontMetadata(buffer);
    logger.info({
      fileName,
      familyName: meta.familyName,
      postscriptName: meta.postscriptName,
      style: meta.style,
      msg: '字体元数据解析完成',
    });

    // 3. 计算 sha256
    const { createHash } = await import('node:crypto');
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    // 4. 存储到对象存储
    const storage = await getStorage();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectKey = `fonts/${Date.now()}_${safeName}`;
    const mimeType = opts.mimeType ?? (ext === '.ttf' ? 'font/ttf' : 'font/otf');
    await storage.putObject({
      objectKey,
      body: buffer,
      mimeType,
      contentLength: buffer.length,
    });

    // 5. 立即安装到系统（写临时文件）
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'font-upload-'));
    const tmpFontPath = path.join(tmpDir, safeName);
    let installResult: InstallResult = { installed: false, reason: 'error', message: '未执行' };
    try {
      await fs.promises.writeFile(tmpFontPath, buffer);
      installResult = await fontInstaller.install(tmpFontPath);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    // 6. 写入 DB（复用 register 逻辑）
    const font = await this.register({
      objectKey,
      familyName: meta.familyName,
      postscriptName: meta.postscriptName,
      style: meta.style,
      sha256,
      licenseNote: opts.licenseNote,
    });

    logger.info({
      fontId: font.id,
      postscriptName: meta.postscriptName,
      installed: installResult.installed,
      msg: '字体上传并注册完成',
    });

    return {
      fontId: font.id,
      code: font.code,
      familyName: font.familyName,
      postscriptName: font.postscriptName,
      style: font.style,
      published: font.published,
      installed: installResult.installed,
      installMessage: installResult.message,
    };
  }

  /**
   * 用 fontkit 解析字体文件元数据
   * 返回 familyName / postscriptName / style
   */
  private async parseFontMetadata(buffer: Buffer): Promise<{
    familyName: string;
    postscriptName: string;
    style: string;
  }> {
    // fontkit v2 是 ESM 包，且 createSync 已被移除，改用 create(buffer)
    // v2 中 create 是同步函数（直接返回 font 对象，非 Promise）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fontkit: any = (await import('fontkit')).default ?? (await import('fontkit'));
    let font: any;
    try {
      font = fontkit.create(buffer);
    } catch (e) {
      throw Errors.validationError(
        `字体文件解析失败，可能不是有效的字体文件: ${(e as Error).message}`,
      );
    }
    if (!font) {
      throw Errors.validationError('字体文件解析返回空结果');
    }
    // TTC 集合字体：取第一个
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (font as any).fonts === 'object' && Array.isArray((font as any).fonts)) {
      font = (font as any).fonts[0];
      if (!font) throw Errors.validationError('TTC 字体集合为空');
    }
    const familyName: string = font.familyName ?? path.basename('', 'ttf');
    const postscriptName: string = font.postscriptName ?? familyName;
    // style：优先 subfamilyName，降级到 italic/bold 推断
    let style: string = font.subfamilyName ?? 'Regular';
    if (!style || typeof style !== 'string') {
      style = font.italic ? (font.bold ? 'Bold Italic' : 'Italic') : (font.bold ? 'Bold' : 'Regular');
    }
    if (!familyName || !postscriptName) {
      throw Errors.validationError('字体元数据缺失 familyName 或 postscriptName');
    }
    return { familyName, postscriptName, style };
  }
}

export const fontService = new FontService();
