locals {
  common_tags = {
    team        = "storefront"
    service     = "acme-shop"
    env         = var.env
    cost-center = "cc-1042"
  }
}

module "network" {
  source     = "./modules/network"
  env        = var.env
  cidr_block = var.vpc_cidr
  tags       = local.common_tags
}

resource "aws_s3_bucket" "assets" {
  bucket = "acme-shop-assets-${var.env}"
  tags   = local.common_tags
}
