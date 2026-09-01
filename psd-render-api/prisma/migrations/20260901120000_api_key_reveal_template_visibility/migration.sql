-- ApiKey：可逆加密的密钥副本（供管理后台随时查看明文；存量为空）
ALTER TABLE "ApiKey" ADD COLUMN "keyEncrypted" TEXT;

-- Template：归属用户 + 可见性（public=企业内可见 / private=仅归属人、企业管理员、平台超管）
ALTER TABLE "Template" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "Template" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';
