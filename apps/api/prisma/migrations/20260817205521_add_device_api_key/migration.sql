-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "api_key_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "devices_api_key_hash_key" ON "devices"("api_key_hash");
