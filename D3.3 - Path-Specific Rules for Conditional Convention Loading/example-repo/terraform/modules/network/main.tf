variable "env" { type = string }
variable "cidr_block" { type = string }
variable "tags" { type = map(string) }

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = "acme-shop-${var.env}" })
}

output "vpc_id" {
  value = aws_vpc.this.id
}
