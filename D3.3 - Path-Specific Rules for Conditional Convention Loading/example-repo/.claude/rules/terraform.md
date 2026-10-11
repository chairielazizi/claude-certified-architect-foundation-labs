---
paths: ["terraform/**/*"]
---
# Terraform conventions

- Terraform >= 1.8, with provider versions pinned in `versions.tf`. Never use unpinned providers.
- Every resource carries `local.common_tags` (team, service, env, cost-center).
- No hard-coded account IDs, regions or ARNs: use variables or data sources.
- State lives in the S3 backend. Never run `terraform apply` locally; propose a change and run
  `terraform plan` only. CI applies after review.
- New modules go in `terraform/modules/<name>/` with `main.tf`, `variables.tf`, `outputs.tf` and a README.
- Run `terraform fmt -recursive` and `terraform validate` before proposing a change.
- Anything that can delete data (`force_destroy`, `prevent_destroy = false`, `skip_final_snapshot`) needs
  an explicit comment explaining why.
