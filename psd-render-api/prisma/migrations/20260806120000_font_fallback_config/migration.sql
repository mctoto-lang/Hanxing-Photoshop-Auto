CREATE TABLE "FontConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fallbackFontVersionId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FontConfig_fallbackFontVersionId_fkey" FOREIGN KEY ("fallbackFontVersionId") REFERENCES "FontVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FontConfig_fallbackFontVersionId_key" ON "FontConfig"("fallbackFontVersionId");
