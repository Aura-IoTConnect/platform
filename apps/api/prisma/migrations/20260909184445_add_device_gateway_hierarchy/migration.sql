-- AlterTable
ALTER TABLE "devices" ADD COLUMN "parent_device_id" TEXT;

-- CreateIndex
CREATE INDEX "devices_parent_device_id_idx" ON "devices"("parent_device_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_parent_device_id_fkey" FOREIGN KEY ("parent_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
