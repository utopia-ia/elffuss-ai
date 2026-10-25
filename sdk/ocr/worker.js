import { serveTask } from '../core/worker-rpc.js';
import * as impl from './impl.js';
serveTask(impl);
