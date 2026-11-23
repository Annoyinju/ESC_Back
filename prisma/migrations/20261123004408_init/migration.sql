/*
  Warnings:

  - You are about to drop the column `name` on the `Drawing` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Drawing" DROP COLUMN "name",
ADD COLUMN     "desc" TEXT,
ADD COLUMN     "title" TEXT;
