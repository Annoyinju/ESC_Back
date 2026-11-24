-- AlterTable
ALTER TABLE "Drawing" ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Drawing_isPublic_createdAt_idx" ON "Drawing"("isPublic", "createdAt");
