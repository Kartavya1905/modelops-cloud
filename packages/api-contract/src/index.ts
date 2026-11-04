// Types generated from openapi.json (`pnpm contract`). Do not edit schema.d.ts by hand.
export type { components, operations, paths } from './schema';
import type { components } from './schema';

type Schemas = components['schemas'];
export type Session = Schemas['SessionDto'];
export type Org = Schemas['OrgDto'];
export type Member = Schemas['MemberDto'];
export type Invitation = Schemas['InvitationDto'];
export type CreatedInvitation = Schemas['CreatedInvitationDto'];
export type Project = Schemas['ProjectDto'];
export type ProjectPage = Schemas['ProjectPageDto'];
export type AuditEvent = Schemas['AuditEventDto'];
export type AuditPage = Schemas['AuditPageDto'];
export type Role = Member['role'];
export type Permission = Session['memberships'][number]['permissions'][number];
