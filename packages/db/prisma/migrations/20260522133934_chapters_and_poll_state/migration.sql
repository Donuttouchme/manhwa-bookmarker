-- AlterTable
ALTER TABLE "SeriesSource" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastPollNote" TEXT,
ADD COLUMN     "lastPolledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Chapter" (
    "id" TEXT NOT NULL,
    "seriesSourceId" TEXT NOT NULL,
    "chapterNumber" DECIMAL(10,2) NOT NULL,
    "title" TEXT NOT NULL,
    "sourceChapterUrl" TEXT,
    "releasedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chapter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chapter_seriesSourceId_chapterNumber_idx" ON "Chapter"("seriesSourceId", "chapterNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Chapter_seriesSourceId_chapterNumber_key" ON "Chapter"("seriesSourceId", "chapterNumber");

-- AddForeignKey
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_seriesSourceId_fkey" FOREIGN KEY ("seriesSourceId") REFERENCES "SeriesSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
