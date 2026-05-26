-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'employee_credentials_provisioned';

-- CreateTable
CREATE TABLE "EmployeeCredential" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "credentialDeliveryStatus" TEXT NOT NULL DEFAULT 'pending',
    "credentialDeliveryError" TEXT,
    "lastCredentialSentAt" TIMESTAMP(3),
    "passwordUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCredential_email_key" ON "EmployeeCredential"("email");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeCredential_username_key" ON "EmployeeCredential"("username");
