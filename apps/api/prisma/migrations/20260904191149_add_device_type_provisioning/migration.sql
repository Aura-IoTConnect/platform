-- AlterTable
ALTER TABLE "device_types" ADD COLUMN "provision_key" TEXT;
ALTER TABLE "device_types" ADD COLUMN "provision_secret_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "device_types_provision_key_key" ON "device_types"("provision_key");
