-- AlterTable
ALTER TABLE "Document"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Document_updatedAt_idx" ON "Document"("updatedAt");

-- CreateIndex
CREATE INDEX "Page_parentId_idx" ON "Page"("parentId");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_acceptedAt_expiresAt_createdAt_idx"
ON "Invite"("workspaceId", "acceptedAt", "expiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "PageInvite_pageId_acceptedAt_expiresAt_createdAt_idx"
ON "PageInvite"("pageId", "acceptedAt", "expiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "AiDailyUsage_userId_updatedAt_idx"
ON "AiDailyUsage"("userId", "updatedAt");
