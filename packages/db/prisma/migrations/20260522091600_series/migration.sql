-- CreateTable
CREATE TABLE "Series" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "coverUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeriesSource" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalMangaId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "lastReadChapter" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "latestChapter" DECIMAL(10,2),
    "latestChapterAt" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeriesSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Series_userId_idx" ON "Series"("userId");

-- CreateIndex
CREATE INDEX "Series_userId_updatedAt_idx" ON "Series"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "SeriesSource_seriesId_idx" ON "SeriesSource"("seriesId");

-- CreateIndex
CREATE INDEX "SeriesSource_nextPollAt_idx" ON "SeriesSource"("nextPollAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeriesSource_seriesId_sourceId_externalMangaId_key" ON "SeriesSource"("seriesId", "sourceId", "externalMangaId");

-- AddForeignKey
ALTER TABLE "Series" ADD CONSTRAINT "Series_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeriesSource" ADD CONSTRAINT "SeriesSource_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
