// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Test builds only: the Worker of the SDK core smoke page.
import { serveTask } from '../sdk/core/worker-rpc.js';
import * as impl from './smoke-impl.js';

serveTask(impl);
