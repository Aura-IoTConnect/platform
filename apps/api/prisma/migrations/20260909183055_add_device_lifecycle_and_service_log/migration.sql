-- AlterTable
ALTER TABLE "devices" ADD COLUMN "firmware_version" TEXT;
ALTER TABLE "devices" ADD COLUMN "hardware_model" TEXT;
ALTER TABLE "devices" ADD COLUMN "manufacturer" TEXT;
ALTER TABLE "devices" ADD COLUMN "commissioned_at" TIMESTAMP(3);
ALTER TABLE "devices" ADD COLUMN "warranty_expires_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "service_log_entries" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_log_entries_device_id_created_at_idx" ON "service_log_entries"("device_id", "created_at");

-- AddForeignKey
ALTER TABLE "service_log_entries" ADD CONSTRAINT "service_log_entries_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
