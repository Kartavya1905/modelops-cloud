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
// M3: experiments + registry
export type Experiment = Schemas['ExperimentDto'];
export type Run = Schemas['RunDto'];
export type RunDetail = Schemas['RunDetailDto'];
export type RunPage = Schemas['RunPageDto'];
export type RunComparison = Schemas['RunComparisonDto'];
export type Model = Schemas['ModelDto'];
export type ModelDetail = Schemas['ModelDetailDto'];
export type ModelVersion = Schemas['ModelVersionDto'];
export type ModelVersionSummary = Schemas['ModelVersionSummaryDto'];
export type DatasetVersion = Schemas['DatasetVersionDto'];
export type Signature = Schemas['SignatureDto'];
