ALTER TABLE "Worker" ADD COLUMN "displayName" TEXT;

CREATE TABLE "StorageConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "backend" TEXT NOT NULL DEFAULT 'local',
    "localStorageDir" TEXT,
    "cosBucket" TEXT,
    "cosRegion" TEXT,
    "cosInternalDomain" TEXT,
    "cosPresignExpiresSec" INTEGER,
    "cosSecretIdEncrypted" TEXT,
    "cosSecretKeyEncrypted" TEXT,
    "updatedAt" DATETIME NOT NULL
);
