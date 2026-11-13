output "instance_id" {
  description = "The server's EC2 instance id (pnpm aws:start / aws:stop find it by tag)."
  value       = aws_instance.server.id
}

output "public_ip" {
  description = "Public IP right after apply. It changes on every stop/start: `pnpm aws:status` shows the current one."
  value       = aws_instance.server.public_ip
}

output "web_url" {
  description = "The web console (reachable from allowed_cidrs only), once the first start has finished (about 10-15 min)."
  value       = "http://${aws_instance.server.public_ip}:3300"
}

output "gateway_url" {
  description = "The inference gateway: POST /v1/endpoints/<slug>/predict with an API key."
  value       = "http://${aws_instance.server.public_ip}:18088"
}

output "grafana_url" {
  description = "Grafana (user admin; password: MO_GRAFANA_ADMIN_PASSWORD in /opt/modelops/.env on the server)."
  value       = "http://${aws_instance.server.public_ip}:13001"
}
