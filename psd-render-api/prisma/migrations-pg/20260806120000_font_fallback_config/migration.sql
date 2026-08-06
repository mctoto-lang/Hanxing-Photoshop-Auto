CREATE TABLE "FontConfig" (
    "id" INTEGER NOT NULL,
    "fallbackFontVersionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FontConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FontConfig_fallbackFontVersionId_key" ON "FontConfig"("fallbackFontVersionId");

ALTER TABLE "FontConfig" ADD CONSTRAINT "FontConfig_fallbackFontVersionId_fkey" FOREIGN KEY ("fallbackFontVersionId") REFERENCES "FontVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
