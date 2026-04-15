import { randomUUID } from 'node:crypto';
import { DocFormat, Prisma, type PrismaClient } from '@prisma/client';

type TxClient = Prisma.TransactionClient | PrismaClient;

type CloneSubtreeOptions = {
  targetWorkspaceId: string;
  targetParentId?: string;
  authorId: string;
};

export async function collectDescendantIds(
  tx: TxClient,
  rootPageId: string,
): Promise<Set<string>> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE subtree AS (
      SELECT id, "parentId"
      FROM "Page"
      WHERE id = ${rootPageId}
      UNION ALL
      SELECT p.id, p."parentId"
      FROM "Page" p
      INNER JOIN subtree s ON p."parentId" = s.id
    )
    SELECT id
    FROM subtree
  `;

  return new Set(rows.map((row) => row.id));
}

export async function collectDescendantIdsForRoots(
  tx: TxClient,
  rootPageIds: string[],
): Promise<Set<string>> {
  if (rootPageIds.length === 0) {
    return new Set<string>();
  }

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE subtree AS (
      SELECT id, "parentId"
      FROM "Page"
      WHERE id IN (${Prisma.join(rootPageIds)})
      UNION ALL
      SELECT p.id, p."parentId"
      FROM "Page" p
      INNER JOIN subtree s ON p."parentId" = s.id
    )
    SELECT DISTINCT id
    FROM subtree
  `;

  return new Set(rows.map((row) => row.id));
}

export async function cloneSubtree(
  tx: TxClient,
  rootPageId: string,
  options: CloneSubtreeOptions,
): Promise<string> {
  const descendantIds = await collectDescendantIds(tx, rootPageId);
  const sourceIds = [...descendantIds];

  const pages = await tx.page.findMany({
    where: {
      id: {
        in: sourceIds,
      },
    },
    select: {
      id: true,
      parentId: true,
      title: true,
      icon: true,
      order: true,
      document: {
        select: {
          body: true,
          format: true,
        },
      },
    },
  });

  if (pages.length === 0) {
    throw new Error('Source page not found');
  }

  const pageById = new Map(pages.map((page) => [page.id, page]));
  const rootPage = pageById.get(rootPageId);
  if (!rootPage) {
    throw new Error('Source page not found');
  }

  const idMap = new Map<string, string>();
  for (const page of pages) {
    idMap.set(page.id, randomUUID());
  }

  const clonedPages = pages.map((page) => {
    const clonedId = idMap.get(page.id);
    if (!clonedId) {
      throw new Error('Failed to generate page id');
    }

    const clonedParentId = page.id === rootPageId
      ? options.targetParentId ?? null
      : page.parentId
        ? idMap.get(page.parentId) ?? null
        : null;

    return {
      id: clonedId,
      workspaceId: options.targetWorkspaceId,
      parentId: clonedParentId,
      title: page.title,
      icon: page.icon,
      order: page.order,
      authorId: options.authorId,
    };
  });

  await tx.page.createMany({
    data: clonedPages,
  });

  const clonedDocuments = pages.map((page) => {
    const pageId = idMap.get(page.id);
    if (!pageId) {
      throw new Error('Failed to map page id for document clone');
    }

    return {
      pageId,
      body: page.document?.body ?? '',
      format: page.document?.format ?? DocFormat.MARKDOWN,
    };
  });

  await tx.document.createMany({
    data: clonedDocuments,
  });

  const newRootId = idMap.get(rootPage.id);
  if (!newRootId) {
    throw new Error('Failed to map cloned root page id');
  }

  return newRootId;
}
