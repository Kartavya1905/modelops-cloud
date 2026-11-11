# s3: the same buckets as the local SeaweedFS (mlflow-artifacts, model-artifacts, datasets,
# drift-captures, reports, uploads-staging). Every bucket: private (all four public-access blocks,
# owner-enforced ACLs), TLS-only, encrypted with KMS, versioned, and with a lifecycle that bounds
# what it keeps. Artifacts are content-addressed (sha256/<hash>), so versioning is a safety net
# against deletes, not a history of edits.

data "aws_caller_identity" "current" {}

locals {
  # S3 names are global: suffix with the account id so two demo deployments never collide.
  bucket_names = { for k, _ in var.buckets : k => "${var.name}-${k}-${data.aws_caller_identity.current.account_id}" }
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_18:Server access logging needs another bucket and grows without bound; CloudTrail data events are the production answer
  #checkov:skip=CKV_AWS_144:Cross-region replication doubles storage cost; every object can be re-created from the source data and MLflow
  #checkov:skip=CKV2_AWS_62:No consumer for event notifications: the worker reads what it needs on its own schedule
  for_each      = var.buckets
  bucket        = local.bucket_names[each.key]
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = var.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = var.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = var.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = var.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms" # the AWS-managed aws/s3 key: no monthly key fee
    }
    bucket_key_enabled = true # one KMS call per bucket key instead of per object
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = var.buckets
  bucket   = aws_s3_bucket.this[each.key].id

  rule {
    id     = "bounded-storage"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_days
    }

    # Staging uploads and captured inputs expire (the 7-day retention of docs/06 SEC-14).
    dynamic "expiration" {
      for_each = var.buckets[each.key].expire_days == null ? [] : [var.buckets[each.key].expire_days]
      content {
        days = expiration.value
      }
    }
  }
}

data "aws_iam_policy_document" "tls_only" {
  for_each = var.buckets

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this[each.key].arn,
      "${aws_s3_bucket.this[each.key].arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each   = var.buckets
  bucket     = aws_s3_bucket.this[each.key].id
  policy     = data.aws_iam_policy_document.tls_only[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.this]
}
