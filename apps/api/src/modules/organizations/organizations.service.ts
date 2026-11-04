import { Injectable } from '@nestjs/common';
import { can } from '../../common/authz/permissions';
import { randomToken, sha256Bytes } from '../../common/crypto';
import { Errors } from '../../common/errors/app-error';
import type { Tx } from '../../common/prisma/prisma.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  ActorContext,
  AuthContext,
  MembershipContext,
} from '../../common/request-context/request-context';
import { uniqueSlug } from '../../common/slug';
import type { Role } from '../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type {
  AcceptedInvitationDto,
  CreatedInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
  MemberDto,
  OrgDto,
} from './organizations.dto';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ orgs

  async listMine(userId: string): Promise<OrgDto[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        org: {
          select: {
            id: true,
            name: true,
            slug: true,
            createdAt: true,
            _count: { select: { memberships: true } },
          },
        },
      },
    });
    return memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      role: m.role,
      memberCount: m.org._count.memberships,
      createdAt: m.org.createdAt.toISOString(),
    }));
  }

  async create(name: string, actor: ActorContext): Promise<OrgDto> {
    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name,
          slug: uniqueSlug(name),
          memberships: { create: { userId: actor.userId, role: 'OWNER' } },
        },
      });
      await this.audit.record(tx, actor, {
        orgId: org.id,
        action: 'organization.created',
        targetType: 'organization',
        targetId: org.id,
      });
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        role: 'OWNER',
        memberCount: 1,
        createdAt: org.createdAt.toISOString(),
      };
    });
  }

  async get(membership: MembershipContext): Promise<OrgDto> {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: membership.orgId },
      include: { _count: { select: { memberships: true } } },
    });
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: membership.role,
      memberCount: org._count.memberships,
      createdAt: org.createdAt.toISOString(),
    };
  }

  // --------------------------------------------------------------- members

  async listMembers(orgId: string): Promise<MemberDto[]> {
    const rows = await this.prisma.membership.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });
    return rows.map((r) => ({
      userId: r.user.id,
      name: r.user.name,
      email: r.user.email,
      role: r.role,
      joinedAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Serializes all membership changes in one organization and returns the caller's *current* role.
   *
   * The role attached by OrgAccessGuard was read before this transaction started, so it may be
   * stale: a concurrent request could have demoted or removed the caller in between
   * (time-of-check vs time-of-use). Locking the organization row first and re-reading the
   * caller's membership under that lock makes every decision below use committed, current data.
   */
  private async lockOrgAndReadActorRole(tx: Tx, orgId: string, actorUserId: string): Promise<Role> {
    await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
    const actor = await tx.membership.findUnique({
      where: { orgId_userId: { orgId, userId: actorUserId } },
      select: { role: true },
    });
    if (!actor) throw Errors.notFound('Organization');
    if (!can(actor.role, 'member:manage')) throw Errors.forbiddenRole('member:manage');
    return actor.role;
  }

  /**
   * Rules (docs/06, section 3):
   *  - only an Owner may grant the Owner role, or change/remove an Owner
   *  - an organization must always keep at least one Owner
   * Must be called after lockOrgAndReadActorRole, with the target read under the same lock.
   */
  private async assertOwnerRules(
    tx: Tx,
    orgId: string,
    actorRole: Role,
    targetRole: Role,
    newRole: Role | null,
  ): Promise<void> {
    const touchesOwner = targetRole === 'OWNER' || newRole === 'OWNER';
    if (touchesOwner && actorRole !== 'OWNER') {
      throw Errors.forbidden(
        'OWNER_REQUIRED',
        'Only an Owner can grant, change or remove the Owner role.',
      );
    }
    if (targetRole === 'OWNER' && newRole !== 'OWNER') {
      const owners = await tx.membership.count({ where: { orgId, role: 'OWNER' } });
      if (owners <= 1) {
        throw Errors.conflict('LAST_OWNER', 'An organization must keep at least one Owner.');
      }
    }
  }

  async changeRole(
    membership: MembershipContext,
    targetUserId: string,
    role: Role,
    actor: ActorContext,
  ): Promise<MemberDto> {
    return this.prisma.$transaction(async (tx) => {
      const actorRole = await this.lockOrgAndReadActorRole(tx, membership.orgId, actor.userId);
      const target = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: membership.orgId, userId: targetUserId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!target) throw Errors.notFound('Member');
      await this.assertOwnerRules(tx, membership.orgId, actorRole, target.role, role);

      const updated = await tx.membership.update({ where: { id: target.id }, data: { role } });
      if (target.role !== role) {
        await this.audit.record(tx, actor, {
          orgId: membership.orgId,
          action: 'member.role_changed',
          targetType: 'user',
          targetId: targetUserId,
          metadata: { from: target.role, to: role },
        });
      }
      return {
        userId: target.user.id,
        name: target.user.name,
        email: target.user.email,
        role: updated.role,
        joinedAt: updated.createdAt.toISOString(),
      };
    });
  }

  async removeMember(
    membership: MembershipContext,
    targetUserId: string,
    actor: ActorContext,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const actorRole = await this.lockOrgAndReadActorRole(tx, membership.orgId, actor.userId);
      const target = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: membership.orgId, userId: targetUserId } },
      });
      if (!target) throw Errors.notFound('Member');
      await this.assertOwnerRules(tx, membership.orgId, actorRole, target.role, null);
      await tx.membership.delete({ where: { id: target.id } });
      await this.audit.record(tx, actor, {
        orgId: membership.orgId,
        action: 'member.removed',
        targetType: 'user',
        targetId: targetUserId,
        metadata: { role: target.role },
      });
    });
  }

  // ----------------------------------------------------------- invitations

  async createInvitation(
    membership: MembershipContext,
    email: string,
    role: Role,
    actor: ActorContext,
  ): Promise<CreatedInvitationDto> {
    if (role === 'OWNER' && membership.role !== 'OWNER') {
      throw Errors.forbidden('OWNER_REQUIRED', 'Only an Owner can invite another Owner.');
    }
    const existing = await this.prisma.membership.findFirst({
      where: { orgId: membership.orgId, user: { email } },
      select: { id: true },
    });
    if (existing) throw Errors.conflict('ALREADY_MEMBER', 'This person is already a member.');

    const token = randomToken(32);
    return this.prisma.$transaction(async (tx) => {
      const inv = await tx.invitation.create({
        data: {
          orgId: membership.orgId,
          email,
          role,
          tokenHash: sha256Bytes(token),
          createdById: actor.userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
      });
      await this.audit.record(tx, actor, {
        orgId: membership.orgId,
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: inv.id,
        metadata: { role },
      });
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
        token,
        acceptPath: `/invite/${token}`,
      };
    });
  }

  async listPendingInvitations(orgId: string): Promise<InvitationDto[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private async findUsableInvitation(token: string) {
    if (token.length < 20 || token.length > 100) return null;
    const inv = await this.prisma.invitation.findUnique({
      where: { tokenHash: sha256Bytes(token) },
      include: { org: { select: { name: true } } },
    });
    if (!inv || inv.acceptedAt !== null || inv.expiresAt <= new Date()) return null;
    return inv;
  }

  async previewInvitation(token: string): Promise<InvitationPreviewDto> {
    const inv = await this.findUsableInvitation(token);
    if (!inv) throw Errors.notFound('Invitation');
    return {
      orgName: inv.org.name,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt.toISOString(),
    };
  }

  /**
   * An invitation is bound to an email address: a leaked link is useless to anyone signed in
   * with a different email. Acceptance is a compare-and-set (`acceptedAt IS NULL`), so the same
   * link can never be used twice, even by two concurrent requests.
   */
  async acceptInvitation(
    token: string,
    auth: AuthContext,
    actor: ActorContext,
  ): Promise<AcceptedInvitationDto> {
    const inv = await this.findUsableInvitation(token);
    if (!inv) throw Errors.notFound('Invitation');
    if (inv.email !== auth.user.email) {
      throw Errors.forbidden(
        'INVITATION_EMAIL_MISMATCH',
        'This invitation was sent to a different email address.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, acceptedAt: null },
        data: { acceptedAt: new Date(), acceptedById: auth.user.id },
      });
      if (claimed.count === 0) throw Errors.notFound('Invitation');

      const already = await tx.membership.findUnique({
        where: { orgId_userId: { orgId: inv.orgId, userId: auth.user.id } },
      });
      if (already) throw Errors.conflict('ALREADY_MEMBER', 'You are already a member.');

      await tx.membership.create({
        data: { orgId: inv.orgId, userId: auth.user.id, role: inv.role },
      });
      await this.audit.record(tx, actor, {
        orgId: inv.orgId,
        action: 'member.joined',
        targetType: 'invitation',
        targetId: inv.id,
        metadata: { role: inv.role },
      });
      return { orgId: inv.orgId };
    });
  }
}
