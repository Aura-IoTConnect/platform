-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "updated_by" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rules" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "updated_by" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "updated_by" TEXT;
