-- CreateEnum
CREATE TYPE "public"."LinkInviteMode" AS ENUM ('OPEN', 'REQUEST');

-- CreateEnum
CREATE TYPE "public"."PageAccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."Workspace"
ADD COLUMN "linkInviteMode" "public"."LinkInviteMode" NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE "public"."PageAccessRequest" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."PageRole" NOT NULL DEFAULT 'VIEWER',
    "status" "public"."PageAccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PageAccessRequest_pageId_userId_key" ON "public"."PageAccessRequest"("pageId", "userId");

-- CreateIndex
CREATE INDEX "PageAccessRequest_pageId_status_idx" ON "public"."PageAccessRequest"("pageId", "status");

-- CreateIndex
CREATE INDEX "PageAccessRequest_userId_idx" ON "public"."PageAccessRequest"("userId");

-- AddForeignKey
ALTER TABLE "public"."PageAccessRequest" ADD CONSTRAINT "PageAccessRequest_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "public"."Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PageAccessRequest" ADD CONSTRAINT "PageAccessRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PageAccessRequest" ADD CONSTRAINT "PageAccessRequest_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "public"."Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
