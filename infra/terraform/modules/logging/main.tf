# logging: one CloudWatch log group per component, plus one shared by all model servers (each
# revision writes its own stream, mo-rev-<id>). Short retention is the main cost control.

resource "aws_cloudwatch_log_group" "this" {
  #checkov:skip=CKV_AWS_158:Encrypted with the CloudWatch-managed key; a customer KMS key costs $1/month per key for no gain in a demo
  #checkov:skip=CKV_AWS_338:7-day retention on purpose (cost control, docs/11 §4); a year of logs is for production
  for_each          = toset(var.components)
  name              = "/${var.name}/${each.key}"
  retention_in_days = var.retention_days
}
