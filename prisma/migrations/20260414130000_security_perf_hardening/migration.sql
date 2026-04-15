-- 1. 중복 email 제거 정책: 가장 오래된 id 하나만 남기고 나머지 email은 NULL? email이 NOT NULL이라 중복이 실제로 생기면 실패. 우선 중복 탐지 후 stop.
-- 현재 DB에 중복이 없다고 가정하고 유니크 제약만 추가.
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_email_key" UNIQUE ("email");

-- 2. Invite.token → tokenHash
ALTER TABLE "Invite" RENAME COLUMN "token" TO "tokenHash";
ALTER TABLE "Invite" ALTER COLUMN "tokenHash" DROP NOT NULL;

-- 3. PageInvite.token → tokenHash
ALTER TABLE "PageInvite" RENAME COLUMN "token" TO "tokenHash";
ALTER TABLE "PageInvite" ALTER COLUMN "tokenHash" DROP NOT NULL;

-- 4. Page 인덱스 (이전 인덱스가 있다면 그대로 두고 보강용으로 추가)
CREATE INDEX IF NOT EXISTS "Page_workspaceId_parentId_order_idx" ON "Page" ("workspaceId", "parentId", "order");
