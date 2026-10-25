// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Scaffold of the depth site: the shared shell only (texts, model store, storage
// panel, labels). The task lands with sdk/depth/ and this file is replaced;
// docs/app-contract.md says what both must do.
import { createShell } from './shared/shell.js';

const shell = await createShell();
shell.setReady(false);
if (!shell.diagnostics.errors.length) shell.setStatus(shell.t('pending'));
