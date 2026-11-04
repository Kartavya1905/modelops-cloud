import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/app-error';
import { decodeCursor, encodeCursor, type Page } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { ActorContext } from '../../common/request-context/request-context';
import { slugify } from '../../common/slug';
import { Prisma, type Project } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { CreateProjectDto, ProjectDto, UpdateProjectDto } from './projects.dto';

function toDto(p: Project): ProjectDto {
  return {
    id: p.id,
    orgId: p.orgId,
    slug: p.slug,
    name: p.name,
    description: p.description,
    createdById: p.createdById,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    archivedAt: p.archivedAt?.toISOString() ?? null,
  };
}

/** Every query includes `orgId` in its WHERE clause: a project id alone is never enough. */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    orgId: string,
    q: { limit: number; cursor?: string | undefined; includeArchived: boolean },
  ): Promise<Page<ProjectDto>> {
    const after = q.cursor ? decodeCursor(q.cursor, ['createdAt', 'id']) : undefined;
    const rows = await this.prisma.project.findMany({
      where: {
        orgId,
        ...(!q.includeArchived && { archivedAt: null }),
        // Keyset pagination on (createdAt DESC, id DESC): stable under concurrent inserts.
        ...(after && {
          OR: [
            { createdAt: { lt: new Date(after.createdAt) } },
            { createdAt: new Date(after.createdAt), id: { lt: after.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map(toDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  async get(orgId: string, projectId: string): Promise<ProjectDto> {
    const p = await this.prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!p) throw Errors.notFound('Project');
    return toDto(p);
  }

  async create(orgId: string, dto: CreateProjectDto, actor: ActorContext): Promise<ProjectDto> {
    const slug = slugify(dto.name);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const p = await tx.project.create({
          data: {
            orgId,
            slug,
            name: dto.name,
            description: dto.description ?? null,
            createdById: actor.userId,
          },
        });
        await this.audit.record(tx, actor, {
          orgId,
          action: 'project.created',
          targetType: 'project',
          targetId: p.id,
          metadata: { slug },
        });
        return toDto(p);
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.conflict(
          'PROJECT_SLUG_TAKEN',
          `A project with the URL name "${slug}" already exists in this organization.`,
        );
      }
      throw err;
    }
  }

  async update(
    orgId: string,
    projectId: string,
    dto: UpdateProjectDto,
    actor: ActorContext,
  ): Promise<ProjectDto> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.project.findFirst({ where: { id: projectId, orgId } });
      if (!existing) throw Errors.notFound('Project');
      const p = await tx.project.update({
        where: { id: existing.id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description || null }),
        },
      });
      const changed = Object.keys(dto).filter((k) => k === 'name' || k === 'description');
      await this.audit.record(tx, actor, {
        orgId,
        action: 'project.updated',
        targetType: 'project',
        targetId: p.id,
        metadata: { fields: changed },
      });
      return toDto(p);
    });
  }

  /** Archiving is a soft delete: the project disappears from lists but its history remains. */
  async archive(orgId: string, projectId: string, actor: ActorContext): Promise<ProjectDto> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.project.findFirst({ where: { id: projectId, orgId } });
      if (!existing) throw Errors.notFound('Project');
      if (existing.archivedAt) return toDto(existing);
      const p = await tx.project.update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
      });
      await this.audit.record(tx, actor, {
        orgId,
        action: 'project.archived',
        targetType: 'project',
        targetId: p.id,
      });
      return toDto(p);
    });
  }
}
