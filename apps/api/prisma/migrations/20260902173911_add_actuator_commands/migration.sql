-- CreateEnum
CREATE TYPE "actuator_command_source" AS ENUM ('RULE', 'MANUAL');

-- CreateTable
CREATE TABLE "actuator_commands" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "rule_id" TEXT,
    "command" TEXT NOT NULL,
    "value" JSONB,
    "source" "actuator_command_source" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actuator_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "actuator_commands_device_id_created_at_idx" ON "actuator_commands"("device_id", "created_at");

-- AddForeignKey
ALTER TABLE "actuator_commands" ADD CONSTRAINT "actuator_commands_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actuator_commands" ADD CONSTRAINT "actuator_commands_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
