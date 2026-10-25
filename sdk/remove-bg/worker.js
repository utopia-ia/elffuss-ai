// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Worker of the remove-bg task: the model runs here, never on the page.
import { serveTask } from '../core/worker-rpc.js';
import * as impl from './impl.js';
serveTask(impl);
