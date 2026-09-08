/**
 * 素材导入 SSRF 白名单单测：
 * 腾讯云同地域机器上 COS 公网域名解析到 169.254.x.x 内网路由地址，
 * validateAssetImportUrl 对可信对象存储域名须放行（跳过 DNS 私有段比对），
 * 其余 SSRF 规则（协议/静态拒绝）不受影响。
 *
 * 全部用例显式传 allowPrivate: false（生产语义），不依赖 NODE_ENV 与真实 DNS。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTrustedAssetImportHost,
  validateAssetImportUrl,
} from './ssrf-guard.js';

const PROD = { allowPrivate: false } as const;

test('isTrustedAssetImportHost：腾讯 COS 桶域名三种形态均命中', () => {
  assert.equal(isTrustedAssetImportHost('bucket-1250000000.cos.ap-guangzhou.myqcloud.com'), true);
  assert.equal(isTrustedAssetImportHost('bucket-1250000000.cos.ap-guangzhou.tencentcos.cn'), true);
  assert.equal(isTrustedAssetImportHost('bucket-1250000000.cos-internal.ap-guangzhou.myqcloud.com'), true);
});

test('isTrustedAssetImportHost：非 COS 形态不命中（含伪造近似域名）', () => {
  assert.equal(isTrustedAssetImportHost('cos.ap-guangzhou.myqcloud.com'), false); // 无桶名
  assert.equal(isTrustedAssetImportHost('evil.com.cos.example.com'), false); // 非法 region 域
  assert.equal(isTrustedAssetImportHost('myqcloud.com.evil.net'), false); // 后缀伪装
  assert.equal(isTrustedAssetImportHost('169.254.169.254'), false); // IP 字面量
  assert.equal(isTrustedAssetImportHost('internal.host'), false);
});

test('isTrustedAssetImportHost：SSRF_TRUSTED_ASSET_HOSTS 白名单精确与后缀匹配', () => {
  process.env.SSRF_TRUSTED_ASSET_HOSTS = 'img.example.com,.cdn.example.org';
  try {
    assert.equal(isTrustedAssetImportHost('img.example.com'), true);
    assert.equal(isTrustedAssetImportHost('a.b.cdn.example.org'), true);
    // 后缀匹配须有域边界：evilcdn.example.org 不应命中 .cdn.example.org
    assert.equal(isTrustedAssetImportHost('evilcdn.example.org'), false);
    assert.equal(isTrustedAssetImportHost('other.example.com'), false);
  } finally {
    delete process.env.SSRF_TRUSTED_ASSET_HOSTS;
  }
});

test('validateAssetImportUrl：可信 COS 域名放行（生产语义，无 DNS 依赖）', async () => {
  const url = 'https://bucket-1250000000.cos.ap-guangzhou.myqcloud.com/ref/ent/2026/09/u.png';
  const r = await validateAssetImportUrl(url, PROD);
  assert.equal(r.ok, true, r.reason ?? '');
});

test('validateAssetImportUrl：静态 SSRF 规则仍然生效', async () => {
  // 协议限制
  assert.equal((await validateAssetImportUrl('ftp://bucket.cos.ap-guangzhou.myqcloud.com/a.png', PROD)).ok, false);
  // 云元数据 IP 字面量（可信域名放行不覆盖 IP 直连）
  assert.equal((await validateAssetImportUrl('http://169.254.169.254/latest/meta-data/', PROD)).ok, false);
  // localhost
  assert.equal((await validateAssetImportUrl('http://localhost:3000/a.png', PROD)).ok, false);
  // 用户信息
  assert.equal((await validateAssetImportUrl('https://u:p@bucket-1250000000.cos.ap-guangzhou.myqcloud.com/a.png', PROD)).ok, false);
});

test('validateAssetImportUrl：URL 格式无效', async () => {
  assert.equal((await validateAssetImportUrl('not-a-url', PROD)).ok, false);
});
