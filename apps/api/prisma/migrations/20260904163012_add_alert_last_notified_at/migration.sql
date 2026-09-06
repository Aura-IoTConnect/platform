-- AlterTable
ALTER TABLE "alerts" ADD COLUMN "last_notified_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "alerts_device_id_rule_id_status_idx" ON "alerts"("device_id", "rule_id", "status");
