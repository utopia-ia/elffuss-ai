#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Deploy depth.elffuss.com. See deploy/lib/deploy-site.sh and deploy/README.md.
#   ELFFUSS_HOST=user@server ELFFUSS_KEY=<ssh key> deploy/deploy-depth.sh [--channel pro|pre] [--ignore-window] [--dry-run]
exec "$(dirname "$0")/lib/deploy-site.sh" depth "$@"
